import assert from 'node:assert/strict';
import test from 'node:test';
import { P10B_CONFIGURATION_EVIDENCE_VERSION, P10B_PROVIDER_IDENTITY, P10B_RUNTIME_PACKET_VERSION,
  p10bProviderIdentityDigest, validateP10bProviderIdentity } from '../server/services/p10bProviderIdentity.js';
import { P10B_QUALIFICATION_VERSION, qualificationDigest,
  validateQualificationContract } from '../server/services/p10bQualificationContract.js';
import { validateP10bRuntimePacket } from '../server/services/p10bQualificationHost.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';

// Pure offline validation. Public resource IDs mirror the reviewed target;
// image/configuration/permission/database hashes are test data, not live proof.
const at = '2026-10-12T16:00:00.000Z';
const digest = (value) => sha256(stableCanonicalJson(value));
function packet(operation = 'prepare') {
  const providerIdentity = structuredClone(P10B_PROVIDER_IDENTITY);
  const providerIdentityDigest = p10bProviderIdentityDigest(providerIdentity);
  const configurationEvidence = { version: P10B_CONFIGURATION_EVIDENCE_VERSION,
    providerIdentity, providerIdentityDigest, verifiedAt: at,
    flySecretMetadataDigest: 'f'.repeat(64), runtimeConfigurationDigests: {
      prepare: 'b'.repeat(64), qualify: 'c'.repeat(64) } };
  const target = { app: 'uckele-group-p10b', machineId: '0803730bd1d7e8', imageDigest: `sha256:${'a'.repeat(64)}` };
  const result = { version: P10B_RUNTIME_PACKET_VERSION, operation, target,
    sourceHead: '1'.repeat(40), databasePath: '/data/p10b-first-mailbox-offline-identity.sqlite', actor: 'offline-owner',
    ownerPermissionDigest: 'd'.repeat(64), configurationEvidence, configurationEvidenceDigest: digest(configurationEvidence),
    budget: { priceEvidenceDigest: 'e'.repeat(64), maximumUsdPerSecond: 0.000002, fixedIncrementalUsd: 0.80 },
    guest: { issuedAt: at, stopAt: '2026-10-12T16:05:00.000Z', closureGraceMs: 30000, stopReserveMs: 30000 } };
  if (operation === 'prepare') return { ...result, runId: 'offline-identity', permissionEvidenceId: 'offline-identity' };
  result.manifest = { version: P10B_QUALIFICATION_VERSION, runtime: { ...target, providerIdentity: structuredClone(providerIdentity),
    providerIdentityDigest, databaseIdentityHash: '2'.repeat(64) }, domain: providerIdentity.domain.name,
    recipient: 'mathew@uckelegroup.com', from: 'P10B Sender <sender@p10b-e2e.uckelegroup.com>',
    replyTo: 'cim-offline@p10b-e2e.uckelegroup.com', ownerPermissionDigest: result.ownerPermissionDigest,
    configurationEvidenceDigest: result.configurationEvidenceDigest, reviewDigest: '3'.repeat(64),
    payloadDigest: '4'.repeat(64), transmissionId: 'offline-transmission', issuedAt: at,
    expiresAt: result.guest.stopAt, maximumRuntimeMs: 300000, maximumCalls: 1, retries: 0, maximumIncrementalUsd: 1 };
  result.reviewedDigest = qualificationDigest(result.manifest);
  result.opportunityId = 'offline-opportunity'; result.initialActivationId = 'offline-activation';
  return result;
}
function rebind(value) {
  const evidence = value.configurationEvidence;
  // An adversarial caller can recompute digests, so drift must also fail the
  // pinned identity check, rather than merely stale hashes or reviewed bytes.
  evidence.providerIdentityDigest = digest(evidence.providerIdentity);
  value.configurationEvidenceDigest = digest(evidence);
  if (value.manifest) {
    value.manifest.runtime.providerIdentity = structuredClone(evidence.providerIdentity);
    value.manifest.runtime.providerIdentityDigest = evidence.providerIdentityDigest;
    value.manifest.configurationEvidenceDigest = value.configurationEvidenceDigest;
    value.reviewedDigest = qualificationDigest(value.manifest);
  }
}
function contract(value, runtime = value.manifest.runtime) {
  return validateQualificationContract({ manifest: value.manifest, now: at, reviewedDigest: value.reviewedDigest,
    observed: { runtime, domain: value.manifest.domain, ownerPermissionDigest: value.ownerPermissionDigest,
      configurationEvidenceDigest: value.configurationEvidenceDigest, freshDatabase: true, stopSupervised: true, incrementalUsd: 0.01 } });
}

test('complete resource identity accepts only the explicit unavailable team ID representation', () => {
  assert.equal(P10B_PROVIDER_IDENTITY.teamId, null);
  assert.equal(P10B_PROVIDER_IDENTITY.teamIdStatus, 'unavailable');
  for (const operation of ['prepare', 'qualify']) assert.doesNotThrow(() => validateP10bRuntimePacket(packet(operation), at));
  const value = packet('qualify');
  assert.equal(contract(value, structuredClone(value.manifest.runtime)).valid, true);
  const reordered = structuredClone(P10B_PROVIDER_IDENTITY); reordered.webhook.events.reverse();
  assert.equal(validateP10bProviderIdentity(reordered), true);
  assert.equal(p10bProviderIdentityDigest(reordered), p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY));
  value.configurationEvidence.providerIdentity = reordered;
  value.configurationEvidenceDigest = digest(value.configurationEvidence);
  value.manifest.configurationEvidenceDigest = value.configurationEvidenceDigest;
  value.reviewedDigest = qualificationDigest(value.manifest);
  assert.doesNotThrow(() => validateP10bRuntimePacket(value, at));
});

const mutations = [
  ['blank identity', () => ({})],
  ['null identity', () => null],
  ['team string alone', () => ({ teamId: 'Uckele-P10B' })],
  ['blank team ID', (i) => { i.teamId = ''; }],
  ['invented team ID', (i) => { i.teamId = 'guessed-team'; }],
  ['missing team ID', (i) => { delete i.teamId; }],
  ['missing unavailable status', (i) => { delete i.teamIdStatus; }],
  ['claimed verified team ID', (i) => { i.teamIdStatus = 'verified'; }],
  ['missing team context', (i) => { delete i.teamContext; }],
  ['wrong team name', (i) => { i.teamContext.displayName = 'uckelegroup'; }],
  ['wrong team plan', (i) => { i.teamContext.plan = 'Free'; }],
  ['unauthenticated context', (i) => { i.teamContext.source = 'caller-label'; }],
  ['missing outbound key', (i) => { delete i.outboundKey; }],
  ['blank outbound ID', (i) => { i.outboundKey.id = ''; }],
  ['guessed valid outbound UUID', (i) => { i.outboundKey.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
  ['wrong outbound name', (i) => { i.outboundKey.name = 'production-outbound'; }],
  ['expanded outbound scope', (i) => { i.outboundKey.permission = 'full_access'; }],
  ['outbound restriction removed', (i) => { i.outboundKey.domainId = null; }],
  ['outbound domain ID conflict', (i) => { i.outboundKey.domainId = i.webhook.id; }],
  ['outbound domain name conflict', (i) => { i.outboundKey.domainName = 'uckelegroup.com'; }],
  ['missing reconciliation key', (i) => { delete i.reconciliationKey; }],
  ['blank reconciliation ID', (i) => { i.reconciliationKey.id = ''; }],
  ['duplicate key IDs', (i) => { i.reconciliationKey.id = i.outboundKey.id; }],
  ['swapped key IDs', (i) => { [i.outboundKey.id, i.reconciliationKey.id] = [i.reconciliationKey.id, i.outboundKey.id]; }],
  ['changed reconciliation scope', (i) => { i.reconciliationKey.permission = 'sending_access'; }],
  ['domain ID drift', (i) => { i.domain.id = i.webhook.id; }],
  ['domain name drift', (i) => { i.domain.name = 'uckelegroup.com'; }],
  ['domain unverified', (i) => { i.domain.status = 'pending'; }],
  ['sending disabled', (i) => { i.domain.sendingEnabled = false; }],
  ['receiving disabled', (i) => { i.domain.receivingEnabled = false; }],
  ['webhook ID drift', (i) => { i.webhook.id = i.domain.id; }],
  ['webhook endpoint drift', (i) => { i.webhook.endpoint = 'https://uckele-group.fly.dev/api/webhooks/resend'; }],
  ['webhook disabled', (i) => { i.webhook.status = 'disabled'; }],
  ['missing event', (i) => { i.webhook.events.pop(); }],
  ['added event', (i) => { i.webhook.events.push('email.suppressed'); }],
  ['duplicate event', (i) => { i.webhook.events[0] = i.webhook.events[1]; }],
  ['extra conflicting field', (i) => { i.sendingKeyId = 'another-key'; }],
  ['extra nested authority', (i) => { i.outboundKey.unrestricted = true; }],
];
test('missing, guessed, conflicting or drifted resource identities fail with recomputed reviewed digests', async (t) => {
  for (const [name, mutate] of mutations) await t.test(name, () => {
    for (const operation of ['prepare', 'qualify']) {
      const value = packet(operation); const identity = value.configurationEvidence.providerIdentity;
      const replacement = mutate(identity);
      if (replacement !== undefined) value.configurationEvidence.providerIdentity = replacement;
      rebind(value);
      assert.throws(() => validateP10bRuntimePacket(value, at));
      if (operation === 'qualify') assert.equal(contract(value).valid, false);
    }
  });
});

test('conflicting legacy fields, identity hashes, stale evidence and old packet versions fail closed', () => {
  for (const mutate of [
    (p) => { delete p.configurationEvidence.providerIdentity; },
    (p) => { p.configurationEvidence.providerIdentityDigest = '9'.repeat(64); },
    (p) => { p.configurationEvidence.teamId = 'legacy-team'; },
    (p) => { p.configurationEvidence.sendingKeyPermission = 'full_access'; },
    (p) => { p.configurationEvidence.verifiedAt = '2020-01-01T00:00:00.000Z'; },
    (p) => { p.configurationEvidence.verifiedAt = '2026-10-12T16:00:01.000Z'; },
    (p) => { p.version = 'p10b-runtime-packet-v2'; },
    (p) => { p.manifest.version = 'p10b-first-mailbox-qualification-v1'; },
    (p) => { p.manifest.runtime.teamId = 'legacy-team'; },
    (p) => { p.manifest.runtime.providerIdentityDigest = '9'.repeat(64); },
  ]) {
    const value = packet('qualify'); mutate(value);
    value.configurationEvidenceDigest = digest(value.configurationEvidence);
    value.manifest.configurationEvidenceDigest = value.configurationEvidenceDigest;
    value.reviewedDigest = qualificationDigest(value.manifest);
    assert.throws(() => validateP10bRuntimePacket(value, at));
  }
});

test('observation must independently carry the same complete pinned resource identity', () => {
  const value = packet('qualify');
  for (const mutate of [
    (r) => { delete r.providerIdentity; },
    (r) => { r.providerIdentity = { teamId: 'Uckele-P10B' }; },
    (r) => { r.providerIdentity.outboundKey.permission = 'full_access'; r.providerIdentityDigest = digest(r.providerIdentity); },
    (r) => { r.providerIdentityDigest = '9'.repeat(64); },
    (r) => { r.teamId = 'legacy-team'; },
  ]) {
    const runtime = structuredClone(value.manifest.runtime); mutate(runtime);
    assert.equal(contract(value, runtime).valid, false);
  }
  assert.throws(() => { P10B_PROVIDER_IDENTITY.outboundKey.id = 'changed'; }, TypeError);
  assert.throws(() => { P10B_PROVIDER_IDENTITY.webhook.events.push('email.suppressed'); }, TypeError);
});
