// Real provider readiness for Pursue CIM sending through the owner's Gmail mailbox
// (spec 2026-11-03 §4.4). The final gate injects this reader; its result is normalized by
// normalizeCimProviderReadiness and bound into the final-gate authority snapshot.
import { getConfig } from '../config.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { createGmailCimProvider } from './gmailCimProvider.js';
import { CONTACT_POLICY_VERSION } from './pursueCimContactPolicy.js';
import { readUsablePursueSignature } from './pursueEmailSignature.js';
import { pursueCimWordingDigest, pursueSignatureComplete } from './pursueCimTemplates.js';

export const PURSUE_CIM_READINESS_EVIDENCE_TTL_MS = 60 * 1000;

/**
 * Every reason readiness can report, in the order it reports them: the spec §4.4 order,
 * with the transient token-refresh failure (Ruling F) after the invalid token, and the
 * signature check (§8.1) last.
 */
export const PURSUE_CIM_READINESS_REASONS = Object.freeze([
  'gmail_not_connected',
  'gmail_token_invalid',
  'gmail_token_refresh_failed',
  'gmail_address_mismatch',
  'wording_not_approved',
  'contact_rule_off',
  'live_sending_off',
  'signature_incomplete',
]);

const GMAIL_REASONS = new Set(PURSUE_CIM_READINESS_REASONS.slice(0, 4));

function orderedReasons(reasons) {
  const present = new Set(reasons);
  return PURSUE_CIM_READINESS_REASONS.filter((reason) => present.has(reason));
}

function instant(value) {
  const parsed = new Date(value ?? Date.now());
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid readiness instant');
  return parsed.toISOString();
}

/** Mailbox reasons from the provider; anything unexpected (or a failure) is not connected. */
async function mailboxReasons(mailProvider) {
  try {
    const result = await mailProvider.readiness();
    const reasons = Array.isArray(result?.reasons) ? result.reasons : [];
    const known = reasons.filter((reason) => GMAIL_REASONS.has(reason));
    if (result?.ready === true && reasons.length === 0) return [];
    return known.length > 0 ? known : ['gmail_not_connected'];
  } catch {
    return ['gmail_not_connected'];
  }
}

async function readControls(storage) {
  try {
    return await storage.getPursueSendControls();
  } catch {
    return null;
  }
}

/**
 * Reads Pursue CIM Gmail readiness. Returns the input shape normalizeCimProviderReadiness
 * expects, plus `ready` and the ordered `reasons`. `ready` is true only when the mailbox is
 * connected under the configured address with a working token, the current wording digest is
 * owner-approved, the contact rule and Live sending are on, and the signature is complete: the
 * sender name is set and the stored Gmail signature snapshot (for the configured address) is
 * not empty. The wording digest includes that snapshot's digest, so a changed Gmail signature
 * reports wording_not_approved until the owner approves again.
 * Never returns secrets: only codes, digests and timestamps.
 */
export async function readPursueCimProviderReadiness({
  storage, providerProfile, now = new Date(), mailProvider, config,
} = {}) {
  const resolvedConfig = config || getConfig();
  const generatedAt = instant(now);
  const provider = mailProvider || createGmailCimProvider({ storage, config: resolvedConfig,
    now: generatedAt });
  const reasons = await mailboxReasons(provider);
  const controls = await readControls(storage);
  const sender = resolvedConfig?.dealHunter?.sender ?? {};
  const signature = await readUsablePursueSignature({ storage, config: resolvedConfig });
  const wordingDigest = pursueCimWordingDigest(sender, signature);
  const wording = controls?.wordingApproval;
  if (wording?.enabled !== true || wording.valueDigest !== wordingDigest) {
    reasons.push('wording_not_approved');
  }
  const contactRule = controls?.contactRule;
  if (contactRule?.enabled !== true || contactRule.policyVersion !== CONTACT_POLICY_VERSION) {
    reasons.push('contact_rule_off');
  }
  if (controls?.liveSending?.enabled !== true) reasons.push('live_sending_off');
  const signatureComplete = pursueSignatureComplete(sender, signature);
  if (!signatureComplete) reasons.push('signature_incomplete');
  const ordered = orderedReasons(reasons);
  const evidenceRevision = sha256(stableCanonicalJson({
    version: 'pursue-cim-gmail-readiness-v1',
    providerProfile: String(providerProfile ?? ''),
    reasons: ordered,
    wordingDigest,
    controlRevisions: {
      liveSending: Number(controls?.liveSending?.revision ?? 0),
      contactRule: Number(controls?.contactRule?.revision ?? 0),
      wordingApproval: Number(controls?.wordingApproval?.revision ?? 0),
    },
  }));
  return {
    provider: 'gmail',
    providerProfile,
    ready: ordered.length === 0,
    reasons: ordered,
    signatureComplete,
    evidenceRevision,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + PURSUE_CIM_READINESS_EVIDENCE_TTL_MS).toISOString(),
  };
}
