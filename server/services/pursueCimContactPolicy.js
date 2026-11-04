import { sha256, stableCanonicalJson } from '../utils/security.js';

/** The standing listing-broker contact rule (spec §7). */
export const CONTACT_POLICY_VERSION = 'listing-broker-inquiry-v1';

/**
 * The digest a campaign enrolled under the rule records, bound to the control revision that
 * was on. Both storage adapters recompute it, so a toggled rule invalidates the basis.
 */
export function contactPolicyDigest(controls) {
  return sha256(stableCanonicalJson({ policyVersion: CONTACT_POLICY_VERSION,
    revision: Number(controls?.contactRule?.revision) }));
}
