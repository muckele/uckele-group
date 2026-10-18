import { createHmac } from 'node:crypto';
import { safeCompareText, sha256, stableCanonicalJson } from '../utils/security.js';
import { qualificationDigest } from './p10bQualificationContract.js';

const profile = 'controlled-mailbox-v1';
const owner = 'mathew@uckelegroup.com';
const domain = 'p10b-e2e.uckelegroup.com';
const digest = (value) => sha256(stableCanonicalJson(value));
const address = (value) => String(value || '').match(/(?:<)?([^<>\s]+@[^<>\s]+)(?:>)?/)?.[1]?.toLowerCase() || '';
const addresses = (value) => (Array.isArray(value) ? value : [value]).filter(Boolean).map(address);
const same = (left, right) => stableCanonicalJson(left) === stableCanonicalJson(right);

function verifyReceipt(receipt, secret) {
  if (receipt?.version !== 'p10b-signed-lifecycle-receipt-v1' || receipt.providerProfile !== profile
    || typeof receipt.rawBody !== 'string' || Buffer.byteLength(receipt.rawBody) > 16384
    || !/^[A-Za-z0-9_-]{1,240}$/.test(receipt.svixId || '')
    || !/^\d{1,12}$/.test(receipt.svixTimestamp || '')
    || typeof receipt.svixSignature !== 'string' || receipt.svixSignature.length > 500
    || !secret) throw new Error('Invalid qualification signature receipt');
  const verifiedAt = Date.parse(receipt.verifiedAt);
  if (!Number.isFinite(verifiedAt)
    || Math.abs(verifiedAt / 1000 - Number(receipt.svixTimestamp)) > 300) {
    throw new Error('Stale qualification signature');
  }
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(
    `${receipt.svixId}.${receipt.svixTimestamp}.${receipt.rawBody}`).digest('base64');
  if (!key.length || !receipt.svixSignature.split(' ').some((entry) =>
    entry.startsWith('v1,') && safeCompareText(entry.slice(3), signature))) {
    throw new Error('Invalid qualification signature');
  }
  const payload = JSON.parse(receipt.rawBody);
  if (!payload || Array.isArray(payload) || !['email.delivered', 'email.received'].includes(payload.type)
    || !payload.data || !/^[A-Za-z0-9_.:@-]{1,240}$/.test(payload.data.email_id || '')
    || (payload.data.attachments != null && (!Array.isArray(payload.data.attachments)
      || payload.data.attachments.length !== 0))) {
    throw new Error('Unsupported qualification lifecycle receipt');
  }
  return payload;
}

// Called only after webhook authorization. Reverify the actual raw bytes;
// payload-supplied provenance and shared-secret-only requests confer nothing.
export function captureQualificationSignatureReceipt(request, config, verifiedAt = new Date().toISOString()) {
  if (config?.dealHunter?.cimProvider?.profile !== profile
    || config.dealHunter.cimProvider.mode !== 'controlled-mailbox'
    || typeof request.rawBody !== 'string') return null;
  const receipt = { version: 'p10b-signed-lifecycle-receipt-v1', providerProfile: profile,
    rawBody: request.rawBody, svixId: request.headers?.['svix-id'],
    svixTimestamp: request.headers?.['svix-timestamp'],
    svixSignature: request.headers?.['svix-signature'], verifiedAt };
  try {
    const payload = verifyReceipt(receipt, config.dealHunter.cimProvider.emailWebhookSecret);
    const data = payload.data;
    if (payload.type === 'email.delivered'
      ? !same(addresses(data.to), [owner]) || address(data.from) !== `sender@${domain}`
      : address(data.from) !== owner || addresses(data.to).length !== 1
        || !/^cim-[a-z0-9-]{1,32}@p10b-e2e\.uckelegroup\.com$/.test(addresses(data.to)[0])) return null;
    return receipt;
  } catch { return null; }
}

export function verifyQualificationLifecycle({ manifest, config, snapshot, reconciliation, now }) {
  const start = Date.parse(manifest.issuedAt);
  const end = Math.min(Date.parse(manifest.expiresAt), start + manifest.maximumRuntimeMs);
  const current = Date.parse(now);
  const inWindow = (value) => Number.isFinite(Date.parse(value))
    && Date.parse(value) >= start && Date.parse(value) <= current && Date.parse(value) < end;
  if (!inWindow(now) || snapshot?.transmission?.id !== manifest.transmissionId
    || snapshot.transmission.payload_digest !== manifest.payloadDigest
    || snapshot.transmission.state !== 'accepted' || snapshot.transmission.provider !== 'resend'
    || snapshot.transmission.invocation_authority_count !== 1) throw new Error('Qualification lifecycle authority changed');
  const providerId = snapshot.transmission.provider_message_id;
  const parsed = (value) => typeof value === 'string' ? JSON.parse(value) : value;
  const expectedBinding = { transmissionId: manifest.transmissionId, payloadDigest: manifest.payloadDigest,
    providerIdempotencyKey: snapshot.transmission.provider_idempotency_key,
    fromAddress: snapshot.transmission.from_address,
    toAddresses: parsed(snapshot.transmission.to_addresses),
    ccAddresses: parsed(snapshot.transmission.cc_addresses), bccAddresses: parsed(snapshot.transmission.bcc_addresses),
    replyToAddress: snapshot.transmission.reply_to_address, subject: snapshot.transmission.subject,
    providerProfile: profile };
  if (reconciliation?.provider !== 'resend' || reconciliation.type !== 'provider-read'
    || reconciliation.providerProfile !== profile || reconciliation.outcome !== 'accepted'
    || !same(reconciliation.binding, expectedBinding)
    || !inWindow(reconciliation.observedAt) || reconciliation.candidates?.length !== 1
    || reconciliation.candidates[0].providerMessageId !== providerId) {
    throw new Error('Qualification provider reconciliation is not exact');
  }
  const receiptFor = (event, type) => {
    const receipt = event?.metadata?.qualificationSignatureReceipt;
    const payload = verifyReceipt(receipt, config.dealHunter.cimProvider.emailWebhookSecret);
    const eventAt = payload.data.created_at || payload.created_at;
    if (event.source !== 'webhook' || event.provider !== 'resend' || event.recipient_email !== owner
      || event.provider_event_id !== receipt.svixId || payload.type !== type
      || event.message_id !== payload.data.email_id || !inWindow(receipt.verifiedAt)
      || Number(receipt.svixTimestamp) * 1000 < start - 1000
      || Number(receipt.svixTimestamp) * 1000 > current + 1000
      || Date.parse(event.created_at) !== Date.parse(eventAt)
      || !inWindow(eventAt) || Date.parse(eventAt) > Date.parse(receipt.verifiedAt) + 1000) {
      throw new Error('Qualification signed event binding changed');
    }
    return { receipt, payload };
  };
  const delivery = receiptFor(snapshot.delivery, 'email.delivered');
  if (snapshot.delivery.event_type !== 'delivered' || snapshot.delivery.message_id !== providerId
    || !same(addresses(delivery.payload.data.to), [manifest.recipient])
    || delivery.payload.data.from !== manifest.from) throw new Error('Qualification delivery is not request-bound');
  if (delivery.payload.data.subject != null && delivery.payload.data.subject !== snapshot.transmission.subject) {
    throw new Error('Qualification delivery subject changed');
  }
  const reply = receiptFor(snapshot.reply, 'email.received');
  if (snapshot.reply.event_type !== 'replied' || address(reply.payload.data.from) !== manifest.recipient
    || !same(addresses(reply.payload.data.to), [manifest.replyTo])) {
    throw new Error('Qualification reply alias or sender changed');
  }
  const inbound = snapshot.inbound;
  const resolution = snapshot.resolution;
  const terminal = snapshot.terminal;
  if (!inbound || inbound.provider !== 'resend' || inbound.direction !== 'inbound'
    || inbound.provider_message_id !== snapshot.reply.message_id
    || inbound.source_event_id !== reply.receipt.svixId || inbound.content_state !== 'complete'
    || inbound.from_address !== manifest.recipient || !same(inbound.to_addresses, [manifest.replyTo])
    || !Array.isArray(inbound.attachment_metadata) || inbound.attachment_metadata.length !== 0
    || inbound.metadata?.attachmentCount !== 0 || !inWindow(inbound.metadata?.contentRetrievedAt)
    || Date.parse(inbound.metadata?.contentRetrievedAt) < Date.parse(reply.receipt.verifiedAt)
    || !resolution?.exact || resolution.ambiguous || resolution.method !== 'reply-alias'
    || resolution.transmission?.id !== manifest.transmissionId
    || resolution.conversation?.state !== 'responded' || terminal?.scope !== 'conversation'
    || terminal.scope_id !== resolution.conversation.id || terminal.reason_code !== 'reply_received'
    || terminal.evidence_id !== reply.receipt.svixId || terminal.evidence_type !== 'signed-inbound-reply-alias'
    || terminal.actor !== 'signed-email-webhook' || terminal.source !== 'pursue-cim-inbound'
    || Date.parse(terminal.observed_at) !== Date.parse(snapshot.reply.created_at)
    || !inWindow(terminal.observed_at)) throw new Error('Qualification inbound retrieval or resolution is incomplete');
  const terminalBinding = { providerEventId: reply.receipt.svixId, provider: 'resend', method: 'reply-alias',
    conversationId: resolution.conversation.id, transmissionId: manifest.transmissionId,
    campaignIds: [...resolution.campaignIds].sort(), touchIds: [...resolution.touchIds].sort(),
    providerProfile: profile };
  if (terminal.metadata_digest !== digest(terminalBinding)) throw new Error('Qualification terminal evidence drift');
  const canonical = { version: 'p10b-verified-lifecycle-artifact-v1',
    scope: 'isolated-first-mailbox-qualification', manifestDigest: qualificationDigest(manifest),
    providerProfile: profile, transmissionIdHash: sha256(manifest.transmissionId), payloadDigest: manifest.payloadDigest,
    deliveryReceiptDigest: digest(delivery.receipt), replyReceiptDigest: digest(reply.receipt),
    reconciliationDigest: digest(reconciliation), inboundContentDigest: sha256(inbound.body_text || ''),
    terminalEvidenceDigest: terminal.metadata_digest, generatedAt: now, expiresAt: new Date(end).toISOString(),
    lifecycleVerified: true, productionReady: false };
  return { ...canonical, digest: digest(canonical) };
}

export async function readQualificationLifecycleSnapshot({ storage, manifest }) {
  // Read the transmission by its exact identity, not a caller-selected latest campaign.
  const context = await storage.readCimFinalGateContext({ transmissionId: manifest.transmissionId,
    authorizationId: `p10b-q-${qualificationDigest(manifest).slice(0, 48)}` });
  const events = await storage.listEmailEvents({ recipientEmail: manifest.recipient, source: 'webhook', limit: 100 });
  const delivery = events.find((event) => event.event_type === 'delivered'
    && event.message_id === context?.transmission?.provider_message_id);
  const reply = events.find((event) => event.event_type === 'replied'
    && event.metadata?.qualificationSignatureReceipt
    && (() => { try { return same(addresses(JSON.parse(event.metadata.qualificationSignatureReceipt.rawBody).data.to), [manifest.replyTo]); }
      catch { return false; } })());
  if (!delivery || !reply) return null;
  const inbound = await storage.getCrmCommunicationByProviderMessage('resend', reply.message_id, 'inbound');
  if (!inbound || inbound.content_state !== 'complete') return null;
  const resolution = await storage.resolvePursueCimInboundEvidence({ provider: 'resend',
    replyToAddresses: [manifest.replyTo], providerMessageIds: [], rfcMessageIds: [], taggedTouchIds: [] });
  const terminal = await storage.readCimQualificationTerminalEvidence({ conversationId: resolution.conversation?.id,
    providerEventId: reply.provider_event_id });
  if (!terminal) return null;
  return { transmission: context?.transmission, delivery, reply, inbound, resolution, terminal };
}
