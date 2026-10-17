import { sha256, stableCanonicalJson } from '../utils/security.js';

export const P10B_RUNTIME_PACKET_VERSION = 'p10b-runtime-packet-v3';
export const P10B_CONFIGURATION_EVIDENCE_VERSION = 'p10b-isolated-configuration-evidence-v2';

// Frozen nonsecret bindings observed in the authenticated isolated dashboard.
// This is an exact first-mailbox target, not a general account selector. A
// resource rotation requires new evidence and independently reviewed code.
export const P10B_PROVIDER_IDENTITY = Object.freeze({
  version: 'p10b-provider-resource-identity-v1',
  provider: 'resend',
  teamId: null,
  teamIdStatus: 'unavailable',
  teamContext: Object.freeze({ displayName: 'Uckele P10B', plan: 'Pro', source: 'authenticated-dashboard' }),
  domain: Object.freeze({ id: '25679efd-65ac-458c-a0d2-2d2e0974faed', name: 'p10b-e2e.uckelegroup.com',
    status: 'verified', sendingEnabled: true, receivingEnabled: true }),
  outboundKey: Object.freeze({ id: '86021142-82c1-41d0-a02c-bf2f2672f7aa', name: 'UG-P10B-outbound',
    permission: 'sending_access', domainId: '25679efd-65ac-458c-a0d2-2d2e0974faed',
    domainName: 'p10b-e2e.uckelegroup.com' }),
  reconciliationKey: Object.freeze({ id: '7ddd7fe6-7d1a-467b-bbf0-f78e0286a02a',
    name: 'UG-P10B-reconciliation', permission: 'full_access' }),
  webhook: Object.freeze({ id: '1322fbe8-2004-4268-839b-8b046e214e68',
    endpoint: 'https://uckele-group-p10b.fly.dev/api/webhooks/resend', status: 'enabled',
    events: Object.freeze(['email.bounced', 'email.clicked', 'email.complained', 'email.delivered',
      'email.delivery_delayed', 'email.failed', 'email.opened', 'email.received', 'email.sent']) }),
});

function canonicalIdentity(identity) {
  // Subscription order is not identity; duplicates, omissions and additional
  // events still differ from the exact pinned set. Reject all extra fields.
  return stableCanonicalJson({ ...identity,
    webhook: { ...identity.webhook, events: [...identity.webhook.events].sort() } });
}

const pinnedIdentity = canonicalIdentity(P10B_PROVIDER_IDENTITY);

export function validateP10bProviderIdentity(identity) {
  try {
    return Array.isArray(identity?.webhook?.events) && canonicalIdentity(identity) === pinnedIdentity;
  } catch { return false; }
}

export function p10bProviderIdentityDigest(identity) {
  if (!validateP10bProviderIdentity(identity)) throw new Error('Isolated provider resource identity changed');
  return sha256(canonicalIdentity(identity));
}
