import { sha256, stableCanonicalJson } from '../utils/security.js';

/** The standing listing-broker contact rule (spec §7). */
export const CONTACT_POLICY_VERSION = 'listing-broker-inquiry-v1';

/**
 * The digest a campaign enrolled under the rule records. It covers the policy version only,
 * not the control revision, so turning the rule off pauses rule-based campaigns and turning
 * it on again resumes them. The revision is recorded on the campaign for audit.
 */
export function contactPolicyDigest() {
  return sha256(stableCanonicalJson({ policyVersion: CONTACT_POLICY_VERSION }));
}

/**
 * True when a campaign row's permission basis is the standing contact rule (Ruling H): it
 * records the rule's policy version and that version's digest. Whether the rule is on now is
 * a separate, send-time check.
 */
export function isContactRuleCampaign(campaign) {
  return campaign?.permission_version === CONTACT_POLICY_VERSION
    && campaign?.permission_digest === contactPolicyDigest();
}
