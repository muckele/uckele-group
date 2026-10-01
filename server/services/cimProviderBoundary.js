import { sha256, stableCanonicalJson } from '../utils/security.js';
import { buildCimProviderPayloadDigest } from '../utils/cimProviderPayload.js';

export { buildCimProviderPayloadDigest } from '../utils/cimProviderPayload.js';

const cimMessageKinds = new Set([
  'deal-hunter-cim-request',
  'deal-hunter-cim-follow-up',
  'cim-initial',
  'cim-follow-up',
  'cim-batch',
]);

const authorizedBoundaryObjects = new WeakSet();
const writerCapabilities = new Map([
  ['pursue-cim-initial', 'fl04b-initial'],
  ['pursue-cim-autopilot-initial', 'fl04b-initial'],
  ['pursue-cim-follow-up', 'fl04c-followup'],
  ['pursue-cim-autopilot-follow-up', 'fl04c-followup'],
  ['pursue-cim-batch', 'fl04c-batch'],
  ['pursue-cim-autopilot-batch', 'fl04c-batch'],
]);

const capabilityWork = new Map([
  ['fl04b-initial', { kind: 'cim-initial', minimumMembers: 1, maximumMembers: 1, touchKind: 'initial' }],
  ['fl04c-followup', { kind: 'cim-follow-up', minimumMembers: 1, maximumMembers: 1, excludeTouchKind: 'initial' }],
  ['fl04c-batch', { kind: 'cim-batch', minimumMembers: 2, maximumMembers: Number.MAX_SAFE_INTEGER }],
]);

function recipients(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map(String);
}

function equal(left, right) {
  return stableCanonicalJson(left) === stableCanonicalJson(right);
}

export function createCimProviderBoundaryAuthorization({
  finalGateResult, authorizationId, writerPath, providerProfile, actor,
} = {}) {
  const capability = writerCapabilities.get(writerPath);
  if (!capability
    || finalGateResult?.authorized !== true
    || finalGateResult?.transmission?.state !== 'provider-pending'
    || Number(finalGateResult?.transmission?.invocation_authority_count) !== 1
    || typeof finalGateResult?.boundaryNonce !== 'string'
    || finalGateResult.boundaryNonce.length < 16) {
    throw new TypeError('A successful same-process CIM final gate is required.');
  }
  const authorization = Object.freeze({
    transmissionId: finalGateResult.transmission.id,
    authorizationId: String(authorizationId || ''),
    writerPath,
    capability,
    providerProfile: String(providerProfile || ''),
    expectedRowVersion: Number(finalGateResult.transmission.row_version),
    boundaryNonce: finalGateResult.boundaryNonce,
    actor: String(actor || ''),
  });
  if (!authorization.transmissionId || !authorization.authorizationId
    || !authorization.providerProfile || !authorization.actor
    || !Number.isSafeInteger(authorization.expectedRowVersion)) {
    throw new TypeError('The CIM provider boundary identity is incomplete.');
  }
  authorizedBoundaryObjects.add(authorization);
  return authorization;
}

function denied(errorCategory, reconciliationOnly = false) {
  return { allowed: false, errorCategory, reconciliationOnly };
}

async function deniedWithObservation({ storage, authorization, errorCategory,
  reconciliationOnly = false, now }) {
  const outcome = denied(errorCategory, reconciliationOnly);
  if (typeof storage?.recordCimProviderBoundaryRejection !== 'function') return outcome;
  try {
    await storage.recordCimProviderBoundaryRejection({
      transmissionId: authorization.transmissionId,
      authorizationId: authorization.authorizationId,
      reasonCode: errorCategory,
      reconciliationOnly,
      expectedRowVersion: authorization.expectedRowVersion,
      actor: authorization.actor,
      now,
    });
  } catch {
    return outcome;
  }
  return outcome;
}

export async function enterCimProviderBoundary({
  message, storage, authorization, now = new Date(),
} = {}) {
  if (!authorizedBoundaryObjects.has(authorization)) {
    return denied('cim-provider-authorization-required');
  }
  if (typeof storage?.readCimFinalGateContext !== 'function'
    || typeof storage?.enterCimProviderSeam !== 'function') {
    return denied('cim-provider-seam-unauthorized');
  }
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const reject = (errorCategory, reconciliationOnly = false) => deniedWithObservation({
    storage, authorization, errorCategory, reconciliationOnly, now: nowIso,
  });
  let durable;
  try {
    durable = await storage.readCimFinalGateContext({
      transmissionId: authorization.transmissionId,
      authorizationId: authorization.authorizationId,
      writerPath: authorization.writerPath,
      providerProfile: authorization.providerProfile,
      now: nowIso,
    });
  } catch {
    return reject('cim-provider-seam-unauthorized');
  }
  const transmission = durable?.transmission;
  const liveAuthorization = durable?.authorization;
  const activation = durable?.activation;
  const communication = durable?.communication;
  const outbox = durable?.outbox;
  const members = Array.isArray(durable?.members) ? durable.members : [];
  const expectedWork = capabilityWork.get(authorization.capability);
  if (!transmission || !liveAuthorization || !activation || !communication || !outbox
    || !expectedWork
    || members.length < 1
    || message?.transmissionId !== authorization.transmissionId
    || message?.communicationId !== transmission.communication_id
    || transmission.communication_id !== communication.id
    || transmission.outbox_id !== outbox.id
    || outbox.communication_id !== communication.id
    || transmission.state !== 'provider-pending'
    || activation.status !== 'current'
    || communication.delivery_state !== 'provider-pending'
    || outbox.state !== 'provider-pending'
    || Number(transmission.invocation_authority_count) !== 1) {
    return reject('cim-provider-work-mismatch');
  }
  if (message.kind !== expectedWork.kind
    || communication.kind !== expectedWork.kind
    || members.length < expectedWork.minimumMembers
    || members.length > expectedWork.maximumMembers
    || (expectedWork.touchKind
      && members.some((member) => member?.touch?.kind !== expectedWork.touchKind))
    || (expectedWork.excludeTouchKind
      && members.some((member) => member?.touch?.kind === expectedWork.excludeTouchKind))) {
    return reject('cim-provider-work-mismatch');
  }
  if (transmission.provider_seam_entered_at) {
    return reject('cim-provider-seam-already-entered', true);
  }
  if (liveAuthorization.id !== authorization.authorizationId
    || liveAuthorization.transmission_id !== transmission.id
    || liveAuthorization.activation_id !== activation.id
    || liveAuthorization.capability !== authorization.capability
    || activation.capability !== authorization.capability
    || writerCapabilities.get(authorization.writerPath) !== authorization.capability
    || liveAuthorization.maximum_calls !== 1
    || !liveAuthorization.consumed_at
    || liveAuthorization.withdrawn_at
    || Date.parse(liveAuthorization.expires_at) <= Date.parse(nowIso)) {
    return reject('cim-provider-seam-unauthorized');
  }
  if (liveAuthorization.writer_path !== authorization.writerPath) {
    return reject('cim-provider-writer-path-mismatch');
  }
  if (liveAuthorization.provider_profile !== authorization.providerProfile
    || activation.provider_profile !== authorization.providerProfile) {
    return reject('cim-provider-profile-mismatch');
  }
  if (sha256(authorization.boundaryNonce) !== transmission.boundary_nonce_digest) {
    return reject('cim-provider-nonce-invalid');
  }
  const touchIds = members.map((member) => member?.touch?.id).filter(Boolean).sort();
  const templateVersions = members.map((member) => member?.campaign?.template_version || '');
  const payloadDigest = buildCimProviderPayloadDigest({
    message, touchIds, templateVersions, payloadVersion: transmission.payload_version,
  });
  const messageMatchesCommunication = message.idempotencyKey === transmission.provider_idempotency_key
    && message.from === communication.from_address
    && equal(recipients(message.to), communication.to_addresses)
    && equal(recipients(message.cc), communication.cc_addresses)
    && equal(recipients(message.bcc), communication.bcc_addresses)
    && message.replyTo === communication.reply_to_address
    && message.subject === communication.subject
    && message.text === communication.body_text
    && message.html === communication.body_html_sanitized
    && equal(message.tags || [], communication.tags || []);
  if (!messageMatchesCommunication
    || payloadDigest !== transmission.payload_digest
    || liveAuthorization.payload_digest !== transmission.payload_digest) {
    return reject('cim-provider-payload-mismatch');
  }
  let seam;
  try {
    seam = await storage.enterCimProviderSeam({
      transmissionId: transmission.id,
      authorizationId: liveAuthorization.id,
      writerPath: authorization.writerPath,
      providerProfile: authorization.providerProfile,
      capability: authorization.capability,
      payloadDigest,
      boundaryNonceDigest: sha256(authorization.boundaryNonce),
      expectedRowVersion: authorization.expectedRowVersion,
      actor: authorization.actor,
      now: nowIso,
    });
  } catch {
    return reject('cim-provider-seam-unauthorized', true);
  }
  if (seam?.alreadyEntered) return reject('cim-provider-seam-already-entered', true);
  if (!seam?.entered) return reject('cim-provider-seam-unauthorized');
  return { allowed: true, payloadDigest,
    providerFinalizationRowVersion: authorization.expectedRowVersion + 1 };
}

function metadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tagNames(tags) {
  return new Set((Array.isArray(tags) ? tags : []).map((tag) => (
    typeof tag === 'string' ? tag.split('=')[0] : tag?.name || tag?.key || ''
  )).filter(Boolean));
}

function hasCimKindNamespace(kind) {
  const normalized = String(kind || '');
  return normalized.startsWith('cim-') || normalized.startsWith('deal-hunter-cim-');
}

function durableRecordIsCim(record) {
  if (!record || typeof record !== 'object') return false;
  const recordMetadata = metadata(record.metadata);
  return Boolean(
    record.cim_request_id
    || record.transmission_id
    || recordMetadata.cimRequestId
    || recordMetadata.cim_request_id
    || recordMetadata.transmissionId
    || recordMetadata.manualTakeover
    || recordMetadata.manualTakeoverCimRequestId
    || record.source === 'pursue-cim-autopilot'
    || hasCimKindNamespace(record.kind)
    || cimMessageKinds.has(record.kind)
  );
}

export async function classifyCimProtectedWork(message = {}, { storage } = {}) {
  const tags = tagNames(message.tags);
  const inMemoryProtected = hasCimKindNamespace(message.kind)
    || Boolean(message.transmissionId || message.cimRequestId)
    || Boolean(message.tracking?.cimRequestId || message.tracking?.transmissionId)
    || ['cim_request_id', 'cim-request-id', 'transmission_id', 'transmission-id']
      .some((name) => tags.has(name));

  let communication = null;
  let outbox = null;
  if (message.communicationId && typeof storage?.getCrmCommunication === 'function') {
    communication = await storage.getCrmCommunication(message.communicationId);
  }
  if (message.outboxId && typeof storage?.getCrmEmailOutbox === 'function') {
    outbox = await storage.getCrmEmailOutbox(message.outboxId);
  }

  return {
    protected: inMemoryProtected || durableRecordIsCim(communication) || durableRecordIsCim(outbox),
    communication,
    outbox,
  };
}

export function isKnownCimMessageKind(kind) {
  return cimMessageKinds.has(kind);
}
