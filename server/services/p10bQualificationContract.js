import { sha256, stableCanonicalJson } from '../utils/security.js';
import { p10bProviderIdentityDigest, validateP10bProviderIdentity } from './p10bProviderIdentity.js';

export const P10B_QUALIFICATION_WRITER = 'p10b-first-mailbox-qualification';
export const P10B_QUALIFICATION_VERSION = 'p10b-first-mailbox-qualification-v2';
const digestPattern = /^[0-9a-f]{64}$/;
const runtimeKeys = ['providerIdentityDigest', 'app', 'machineId', 'imageDigest', 'databaseIdentityHash'];
const runtimeFields = new Set([...runtimeKeys, 'providerIdentity']);
const grants = new WeakMap();

export function validateP10bProviderRuntime(runtime) {
  return runtime && Object.keys(runtime).every((key) => runtimeFields.has(key))
    && validateP10bProviderIdentity(runtime.providerIdentity)
    && p10bProviderIdentityDigest(runtime.providerIdentity) === runtime.providerIdentityDigest;
}

export function qualificationDigest(manifest) {
  return sha256(stableCanonicalJson(manifest));
}

export function qualificationReason(manifest) {
  return `${P10B_QUALIFICATION_VERSION}:${qualificationDigest(manifest)}`;
}

// This describes permission to perform a single qualification exchange. It
// deliberately contains no production-readiness or verified-lifecycle flags.
export function validateQualificationContract({ manifest, observed, now,
  reviewedDigest, transmission, communication, authorization } = {}) {
  const deny = (reason) => ({ valid: false, reason });
  if (!manifest || manifest.version !== P10B_QUALIFICATION_VERSION
    || !digestPattern.test(reviewedDigest || '')
    || qualificationDigest(manifest) !== reviewedDigest) return deny('manifest_binding');
  const start = Date.parse(manifest.issuedAt);
  const end = Date.parse(manifest.expiresAt);
  const current = Date.parse(now);
  if (![start, end, current].every(Number.isFinite) || current < start || current >= end
    || end <= start || end - start > 15 * 60 * 1000) return deny('qualification_expired');
  if (manifest.maximumCalls !== 1 || manifest.retries !== 0
    || !Number.isFinite(manifest.maximumIncrementalUsd)
    || manifest.maximumIncrementalUsd <= 0 || manifest.maximumIncrementalUsd > 1
    || !Number.isSafeInteger(manifest.maximumRuntimeMs) || manifest.maximumRuntimeMs <= 0
    || manifest.maximumRuntimeMs > end - start
    || current - start >= manifest.maximumRuntimeMs) return deny('qualification_limits');
  if (manifest.runtime?.app !== 'uckele-group-p10b'
    || !validateP10bProviderRuntime(manifest.runtime)
    || !/^[0-9a-f]{14}$/.test(manifest.runtime?.machineId || '')
    || !/^sha256:[0-9a-f]{64}$/.test(manifest.runtime?.imageDigest || '')
    || !digestPattern.test(manifest.runtime?.databaseIdentityHash || '')
    || manifest.domain !== 'p10b-e2e.uckelegroup.com'
    || manifest.recipient !== 'mathew@uckelegroup.com'
    || manifest.from !== 'P10B Sender <sender@p10b-e2e.uckelegroup.com>'
    || !/^cim-[a-z0-9-]{1,32}@p10b-e2e\.uckelegroup\.com$/.test(manifest.replyTo || '')
    || !digestPattern.test(manifest.ownerPermissionDigest || '')
    || !digestPattern.test(manifest.configurationEvidenceDigest || '')
    || !digestPattern.test(manifest.reviewDigest || '')
    || !digestPattern.test(manifest.payloadDigest || '')
    || typeof manifest.transmissionId !== 'string' || !manifest.transmissionId
    || manifest.transmissionId.length > 240) return deny('qualification_identity');
  if (!observed || !validateP10bProviderRuntime(observed.runtime)
    || runtimeKeys.some((key) => observed.runtime?.[key] !== manifest.runtime[key])
    || observed.domain !== manifest.domain || observed.ownerPermissionDigest !== manifest.ownerPermissionDigest
    || observed.configurationEvidenceDigest !== manifest.configurationEvidenceDigest
    || observed.freshDatabase !== true || observed.stopSupervised !== true
    || !Number.isFinite(observed.incrementalUsd) || observed.incrementalUsd < 0
    || observed.incrementalUsd >= manifest.maximumIncrementalUsd) return deny('execution_binding');
  if (transmission && (transmission.id !== manifest.transmissionId
    || transmission.payload_digest !== manifest.payloadDigest)) return deny('payload_binding');
  if (communication) {
    const addresses = (value) => typeof value === 'string' ? JSON.parse(value) : value;
    try {
      if (communication.from_address !== manifest.from
        || communication.reply_to_address !== manifest.replyTo
        || stableCanonicalJson(addresses(communication.to_addresses)) !== stableCanonicalJson([manifest.recipient])
        || stableCanonicalJson(addresses(communication.cc_addresses)) !== '[]'
        || stableCanonicalJson(addresses(communication.bcc_addresses)) !== '[]') return deny('envelope_binding');
    } catch { return deny('envelope_binding'); }
  }
  if (authorization && (authorization.writer_path !== P10B_QUALIFICATION_WRITER
    || authorization.provider_profile !== 'controlled-mailbox-v1'
    || authorization.reason !== qualificationReason(manifest)
    || authorization.withdrawn_at
    || authorization.issued_at !== manifest.issuedAt || authorization.expires_at !== manifest.expiresAt
    || authorization.maximum_calls !== 1)) return deny('durable_permission_binding');
  return { valid: true, manifestDigest: reviewedDigest };
}

export function assertQualificationHardOff(config) {
  const controlled = config?.dealHunter?.cimProvider;
  if (config?.isProduction !== false || controlled?.enabled !== false
    || controlled.profile !== 'controlled-mailbox-v1' || controlled.provider !== 'resend'
    || controlled.mode !== 'controlled-mailbox'
    || controlled.resendFromEmail !== 'P10B Sender <sender@p10b-e2e.uckelegroup.com>'
    || controlled.resendReplyTo !== 'replies@p10b-e2e.uckelegroup.com'
    || controlled.resendInboundDomain !== 'p10b-e2e.uckelegroup.com'
    || stableCanonicalJson(controlled.allowedRecipients) !== '["mathew@uckelegroup.com"]'
    || !controlled.resendApiKey || !controlled.reconciliationApiKey || !controlled.emailWebhookSecret
    || config.dealHunter?.cimOutreach?.paused !== true
    || config.dealHunter?.cimFollowUp?.enabled !== false
    || config.dealHunter?.cimAutomation?.schedulerEnabled !== false
    || config.dealHunter?.cimAutomation?.paused !== true
    || config.dealHunter?.dailyEmail?.enabled !== false
    || config.followUp?.emailEnabled !== false || config.followUp?.aiEnabled !== false
    || config.delivery?.provider !== 'console'
    || ['resendApiKey', 'resendFromEmail', 'resendReplyTo', 'resendInboundDomain', 'emailWebhookSecret']
      .some((key) => Boolean(config.delivery?.[key]))) {
    throw new Error('P10B qualification hard-off or isolated profile binding failed');
  }
}

// Never reconstruct this grant from persisted digests after a crash. Durable
// consumed/pending records are reconciliation-only, not retry permission.
export function registerQualificationGate(result, qualification) {
  grants.set(result, qualification);
}

export function readQualificationGrant(result) {
  return grants.get(result);
}
