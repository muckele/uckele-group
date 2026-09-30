import { createCimProviderBoundaryAuthorization } from './cimProviderBoundary.js';
import { sendPreparedMessage } from './delivery.js';

function denied() {
  return {
    status: 'failed',
    error: 'The durable CIM provider work could not be reconstructed.',
    errorCategory: 'cim-provider-work-mismatch',
    definitiveFailure: true,
    providerMessageId: '',
  };
}

// This is the only new-transmission orchestration entry. It accepts the
// same-process P6A result, reconstructs the provider message from durable
// records, and delegates the actual enforcement and adapter call to the
// private delivery.sendMessage boundary.
export async function sendAuthorizedCimTransmission({
  storage,
  finalGateResult,
  authorizationId,
  writerPath,
  providerProfile,
  actor,
  now = new Date(),
  configOverride,
  fetcher,
} = {}) {
  if (typeof storage?.readCimFinalGateContext !== 'function') return denied();
  const boundaryAuthorization = createCimProviderBoundaryAuthorization({
    finalGateResult, authorizationId, writerPath, providerProfile, actor,
  });
  let durable;
  try {
    durable = await storage.readCimFinalGateContext({
      transmissionId: boundaryAuthorization.transmissionId,
      authorizationId: boundaryAuthorization.authorizationId,
      writerPath: boundaryAuthorization.writerPath,
      providerProfile: boundaryAuthorization.providerProfile,
      now: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    });
  } catch {
    return denied();
  }
  const transmission = durable?.transmission;
  const communication = durable?.communication;
  const outbox = durable?.outbox;
  if (!transmission || !communication || !outbox) return denied();
  const message = Object.freeze({
    kind: communication.kind,
    transmissionId: transmission.id,
    communicationId: communication.id,
    outboxId: outbox.id,
    idempotencyKey: transmission.provider_idempotency_key,
    from: communication.from_address,
    to: communication.to_addresses,
    cc: communication.cc_addresses,
    bcc: communication.bcc_addresses,
    replyTo: communication.reply_to_address,
    subject: communication.subject,
    text: communication.body_text,
    html: communication.body_html_sanitized,
    tags: communication.tags,
  });
  return sendPreparedMessage(message, {
    storage,
    cimProviderAuthorization: boundaryAuthorization,
    now,
    configOverride,
    fetcher,
  });
}
