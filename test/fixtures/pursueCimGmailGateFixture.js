// A real-SQLite Pursue CIM campaign prepared for the final gate under the production Gmail
// profile: one initial (or one follow-up) transmission, a live authorization, and the
// injected authority readers the final gate needs. Used by the Gmail dispatch tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { calculateCampaignExpiry } from '../../server/services/cimCampaignPolicy.js';
import { authorizePreparedCimTransmission } from '../../server/services/pursueCimFinalGate.js';
import { CONTACT_POLICY_VERSION, contactPolicyDigest } from '../../server/services/pursueCimContactPolicy.js';
import { cimRfcMessageId } from '../../server/services/cimMailProvider.js';
import { sanitizeEmailSignatureHtml, signatureHtmlToText } from '../../server/services/emailSignatureHtml.js';
import { FAKE_CIM_SIGNATURE_HTML, createFakeCimProvider } from '../../server/services/fakeCimProvider.js';
import { readPursueCimProviderReadiness } from '../../server/services/pursueCimReadiness.js';
import { readUsablePursueSignature } from '../../server/services/pursueEmailSignature.js';
import { pursueCimWordingDigest, renderPursueCimEmail } from '../../server/services/pursueCimTemplates.js';
import { createSqliteStorage } from '../../server/storage/sqlite.js';
import { sha256, stableCanonicalJson } from '../../server/utils/security.js';

export const GMAIL_PROFILE = 'production-gmail-v1';
export const SENDER = 'owner@uckele.example.test';
export const BROKER = 'broker@example.test';
export const SENDER_SETTINGS = Object.freeze({ name: 'Mathew Uckele' });
// Tuesday 2026-09-29 09:00 in Los Angeles: inside the send window.
export const GATE_NOW = '2026-09-29T16:00:00.000Z';
const seededAt = '2026-09-25T19:00:00.000Z';
const fill = (character) => character.repeat(64);

export function gmailConfig({ provider = 'gmail', sender = SENDER_SETTINGS } = {}) {
  return {
    isProduction: false,
    server: { outboundRequestTimeoutMs: 100, origin: 'https://app.example.test' },
    delivery: { provider: 'resend', resendApiKey: 'unused-resend-key',
      resendFromEmail: 'unused@example.test' },
    dealHunter: {
      cimProvider: provider === 'gmail'
        ? { enabled: true, profile: GMAIL_PROFILE, mode: 'production-gmail', provider: 'gmail',
          gmailSenderAddress: SENDER, resendApiKey: '', resendFromEmail: '', resendReplyTo: '',
          resendInboundDomain: '', emailWebhookSecret: '', reconciliationApiKey: '',
          allowedRecipients: [] }
        : { enabled: true, profile: GMAIL_PROFILE },
      gmail: { clientId: 'client', clientSecret: 'secret', senderAddress: SENDER, tokenKey: '' },
      sender,
      cimAutomation: { sendWindowStart: '08:00' },
      replyPoller: { enabled: true, intervalMinutes: 5 },
    },
  };
}

function temporaryPath(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ug-${prefix}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'storage.sqlite');
}

/** The broker contact option the fixture campaigns are enrolled for. */
export const FIXTURE_RECIPIENT = Object.freeze({ email: BROKER, displayName: 'Jordan Lee',
  firstName: 'Jordan', provenanceFingerprint: fill('9'), permissionProvenanceFingerprint: fill('a'),
  contactAuthorityRevision: fill('b') });

/** The recipient fingerprint a fixture campaign for `opportunityId` carries. */
export function fixtureRecipientFingerprint(opportunityId) {
  return sha256(stableCanonicalJson({ opportunityId, emailHash: sha256(FIXTURE_RECIPIENT.email),
    provenanceFingerprint: FIXTURE_RECIPIENT.provenanceFingerprint,
    contactAuthorityRevision: FIXTURE_RECIPIENT.contactAuthorityRevision }));
}

/** Broker-materials authority for a fixture opportunity: the recipient, nothing received. */
export function fixtureMemberAuthority(opportunityId) {
  return { opportunityId, recipientOptions: [{ ...FIXTURE_RECIPIENT }],
    materialsState: { materialsReceived: false, advancedBeyondBrokerOutreach: false,
      evidenceCodes: [] }, preparationBlockers: [], suppression: null, terminalReason: '',
    existingRequest: null, opportunityClaim: null, currentDispositionState: 'pursued',
    pursued: true };
}

export async function seedActivationChain(storage, providerProfile = GMAIL_PROFILE) {
  let parentId = null;
  for (const capability of ['fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup']) {
    const id = `gmail-${capability}`;
    await storage.recordCimCapabilityActivation({
      id, capability, mode: 'active', policyHash: fill('a'), configHash: fill('b'),
      actor: 'fixture-owner', reason: 'disposable test authority',
      confirmation: 'fixture-confirmation', providerProfile, now: seededAt,
      ...(capability === 'fl04c-followup' ? { dailyCap: 10, recipientCap: 10 } : {}),
      ...(parentId ? { prerequisiteActivationId: parentId,
        prerequisiteEvidenceId: `evidence-${capability}`, prerequisiteEvidenceHash: fill('c') } : {}),
    });
    parentId = id;
  }
}

/** The stored Gmail signature snapshot for `html` (the fake mailbox's signature by default). */
export function fixtureSignature(html = FAKE_CIM_SIGNATURE_HTML) {
  const sanitized = sanitizeEmailSignatureHtml(html).html;
  return { html: sanitized, text: signatureHtmlToText(sanitized), digest: sha256(sanitized) };
}

/** Stores the owner's Gmail signature snapshot, as a refresh from Gmail would. */
export async function seedSignature(storage, { html = FAKE_CIM_SIGNATURE_HTML, now = seededAt,
  sendAsEmail = SENDER } = {}) {
  const { html: sanitized, text, digest } = fixtureSignature(html);
  return storage.recordGmailSignatureRefresh({ ok: true, sendAsEmail, html: sanitized, text, digest, now });
}

/**
 * Turns every send control on, with the current wording approved. Seeds the fake mailbox's
 * signature first when no signature snapshot is stored.
 */
export async function enableSendControls(storage, { sender = SENDER_SETTINGS, now = seededAt,
  config = gmailConfig({ sender }) } = {}) {
  if (!(await storage.getGmailSignature())) await seedSignature(storage, { now });
  const signature = await readUsablePursueSignature({ storage, config });
  const controls = await storage.getPursueSendControls();
  for (const [controlKey, name, extra] of [
    ['live_sending', 'liveSending', {}],
    ['contact_rule', 'contactRule', { policyVersion: CONTACT_POLICY_VERSION }],
    ['wording_approval', 'wordingApproval', { valueDigest: pursueCimWordingDigest(sender, signature) }],
  ]) {
    await storage.setPursueSendControl({ controlKey, enabled: true, ...extra,
      expectedRevision: controls[name].revision, actor: 'fixture-owner', now });
  }
}

export async function setSendControl(storage, controlKey, enabled, extra = {}) {
  const name = { live_sending: 'liveSending', contact_rule: 'contactRule',
    wording_approval: 'wordingApproval' }[controlKey];
  const controls = await storage.getPursueSendControls();
  await storage.setPursueSendControl({ controlKey, enabled, ...extra,
    expectedRevision: controls[name].revision, actor: 'fixture-owner', now: seededAt });
}

export function seedCampaign(database, suffix, recipientFingerprint, { followUp, now }) {
  const opportunityId = `opp-gmail-${suffix}`;
  const ids = { opportunityId, decisionId: `decision-${suffix}`, enrollmentId: `enrollment-${suffix}`,
    conversationId: `conversation-${suffix}`, campaignId: `campaign-${suffix}`,
    touchId: `touch-${suffix}`, submissionId: `submission-${suffix}` };
  database.prepare(`INSERT INTO deal_hunter_opportunities (opportunity_id, created_at, updated_at,
    canonical_name, identity_version, metadata, discovery_state)
    VALUES (?, ?, ?, 'Acme Plumbing', 'cim-identity-v1', '{}', 'known_prospective')`)
    .run(opportunityId, seededAt, seededAt);
  database.prepare(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key,
    request_digest, opportunity_id, action, actor, expected_discovery_revision,
    expected_material_revision, observed_discovery_revision, observed_material_revision,
    policy_version, created_at) VALUES (?, ?, ?, ?, 'pursue', 'fixture-owner', 0, 0, 0, 0,
    'owner-decision-v1', ?)`).run(ids.decisionId, `idem-${suffix}`, fill('a'), opportunityId, seededAt);
  database.prepare(`INSERT INTO deal_hunter_pursuit_enrollments (id, decision_event_id,
    opportunity_id, state, reason_code, authority_digest, created_at, updated_at, row_version)
    VALUES (?, ?, ?, 'campaign-created', NULL, ?, ?, ?, 2)`)
    .run(ids.enrollmentId, ids.decisionId, opportunityId, fill('b'), seededAt, seededAt);
  database.prepare(`INSERT INTO deal_hunter_opportunity_timezone_revisions (opportunity_id,
    revision, state, iana_timezone, evidence_type, evidence_id, evidence_digest,
    resolver_version, dataset_digest, actor, created_at) VALUES (?, 1, 'verified',
    'America/Los_Angeles', 'operator-verified', 'timezone-evidence', ?, 'explicit-v1', ?,
    'fixture-owner', ?)`).run(opportunityId, fill('c'), fill('d'), seededAt);
  database.prepare(`INSERT INTO deal_hunter_broker_conversations (id, recipient_authority_id,
    recipient_fingerprint, recipient_address, sender_policy_version, reply_policy_version,
    reply_alias_token_digest, rfc_thread_key, state, terminal_revision, batching_policy_version,
    created_at, updated_at, row_version) VALUES (?, 'recipient-authority', ?, ?,
    'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?, ?, 'open', 0,
    'batching-off-v1', ?, ?, 1)`).run(ids.conversationId, recipientFingerprint, BROKER,
    sha256(`reply-alias:${suffix}`), `thread-${suffix}`, seededAt, seededAt);
  database.prepare(`INSERT INTO deal_hunter_cim_campaigns (id, opportunity_id, generation,
    enrollment_id, decision_event_id, policy_version, template_version, template_digest,
    permission_version, permission_digest, permission_revision, permission_scope,
    canonical_revision, crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
    freshness_authority_digest, discovery_revision, material_revision, timezone_revision,
    conversation_id, state, reason_code, terminal_revision, row_version, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, 'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', ?,
    'gmail-fl04b-enrollment', ?, 1, ?, 1, 1, 'recipient-authority', ?, ?, 0, 0, 1, ?,
    'initial-pending', 'awaiting-window', 0, 1, ?, ?)`).run(ids.campaignId, opportunityId,
    ids.enrollmentId, ids.decisionId, fill('1'), fill('2'), fill('f'), recipientFingerprint,
    fill('3'), ids.conversationId, seededAt, seededAt);
  database.prepare(`INSERT INTO deal_hunter_cim_campaign_touches (id, campaign_id,
    opportunity_id, logical_slot, kind, ordinal, due_at, due_local, timezone_revision, state,
    row_version, created_at, updated_at) VALUES (?, ?, ?, 'initial', 'initial', 0, ?,
    '2026-09-29T08:00:00-07:00', 1, 'scheduled', 1, ?, ?)`)
    .run(ids.touchId, ids.campaignId, opportunityId, '2026-09-29T15:00:00.000Z', seededAt, seededAt);
  database.prepare(`INSERT INTO contact_submissions (id, created_at, updated_at, status,
    delivery_provider, delivery_status, crm_status, source, ip_hash, name, email, message,
    deal_hunter_opportunity_id) VALUES (?, ?, ?, 'open', 'none', 'not-attempted', 'active',
    'synthetic', 'synthetic-ip', 'Synthetic broker', ?, 'Synthetic CRM owner', ?)`)
    .run(ids.submissionId, seededAt, seededAt, BROKER, opportunityId);
  database.prepare('UPDATE deal_hunter_opportunities SET primary_submission_id = ? WHERE opportunity_id = ?')
    .run(ids.submissionId, opportunityId);
  const crmRevision = database.prepare(`SELECT MAX(revision) AS revision
    FROM deal_hunter_crm_ownership_revisions WHERE opportunity_id = ?`).get(opportunityId).revision;
  database.prepare(`UPDATE deal_hunter_cim_campaigns SET crm_submission_id = ?,
    crm_ownership_revision = ? WHERE id = ?`).run(ids.submissionId, crmRevision ?? 1, ids.campaignId);
  database.prepare(`INSERT OR IGNORE INTO deal_hunter_source_freshness_state (source_id,
    next_generation, accepted_generation, accepted_run_id, accepted_digest, accepted_at,
    projection_state) VALUES ('sheet-0', 1, 1, 'source-run', ?, ?, 'accepted')`)
    .run(fill('c'), seededAt);
  database.prepare(`INSERT INTO deal_hunter_opportunity_source_observations (id, opportunity_id,
    source_id, source_name, source_record_id, field, value, observed_at, accepted_at,
    accepted_run_id, created_at, updated_at) VALUES (?, ?, 'sheet-0', 'Synthetic Sheet', ?,
    'broker_email', ?, ?, ?, 'source-run', ?, ?)`).run(`source-row-${suffix}`, opportunityId,
    `source-record-${suffix}`, BROKER, seededAt, seededAt, seededAt, seededAt);
  if (followUp) {
    // The follow-up capacity trigger reads the wall clock, so the campaign window is anchored
    // to an initial accepted a day before now.
    const initialAcceptedAt = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    const derivation = calculateCampaignExpiry(initialAcceptedAt, 'America/Los_Angeles', '08:00');
    database.prepare(`UPDATE deal_hunter_cim_campaigns SET state = 'active-follow-up',
      reason_code = NULL, initial_accepted_at = ?, local_expiry_at = ?, expiry_derivation = ?
      WHERE id = ?`).run(initialAcceptedAt, derivation.expiresAt, stableCanonicalJson(derivation),
      ids.campaignId);
    database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET logical_slot = 'follow-up-1',
      kind = 'follow-up-1', ordinal = 1 WHERE id = ?`).run(ids.touchId);
    database.prepare(`UPDATE deal_hunter_broker_conversations SET gmail_thread_id = ?
      WHERE id = ?`).run(`gmail-thread-${suffix}`, ids.conversationId);
  }
  return ids;
}

/**
 * Builds one prepared Pursue transmission ready for the final gate under the Gmail profile.
 * `kind`: 'initial' or 'follow-up'. `basis`: 'activation' (the fl04b chain) or 'rule'.
 */
export async function createGmailGateFixture(t, suffix, { kind = 'initial', basis = 'activation',
  controls = true } = {}) {
  const followUp = kind === 'follow-up';
  const sqlitePath = temporaryPath(t, `gmail-gate-${suffix}`);
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const opportunityId = `opp-gmail-${suffix}`;
  const recipientFingerprint = fixtureRecipientFingerprint(opportunityId);
  const realNow = new Date().toISOString();
  const ids = seedCampaign(database, suffix, recipientFingerprint, { followUp, now: realNow });
  await seedActivationChain(storage, GMAIL_PROFILE);
  database.prepare(`UPDATE deal_hunter_cim_capability_activations SET permission_basis_digest = ?,
    permission_revision = 1, cohort_digest = ? WHERE id = 'gmail-fl04b-initial'`)
    .run(fill('2'), fill('f'));
  database.prepare(`INSERT INTO deal_hunter_cim_safety_settings (id, updated_at, outreach_paused,
    updated_by, metadata) VALUES ('global', ?, 0, 'fixture-owner', '{}')`).run(seededAt);
  if (basis === 'rule') {
    database.prepare(`UPDATE deal_hunter_cim_campaigns SET permission_version = ?,
      permission_digest = ?, permission_revision = 1 WHERE id = ?`)
      .run(CONTACT_POLICY_VERSION, contactPolicyDigest(), ids.campaignId);
  }
  if (controls) await enableSendControls(storage);

  const claimTokenDigest = fill('e');
  // Follow-up preparation and its capacity trigger read the wall clock, so the claim and the
  // reservation are made now; the gate itself runs at the in-window GATE_NOW.
  const claimNow = followUp ? realNow : '2026-09-29T15:30:00.000Z';
  const claim = await storage.claimDueCimTouch({ touchId: ids.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest, claimOwner: 'gmail-worker',
    claimExpiresAt: new Date(Date.parse(followUp ? realNow : GATE_NOW) + 4 * 60 * 1000).toISOString(),
    now: claimNow });
  if (!claim.claimed) throw new Error(`fixture claim failed: ${JSON.stringify(claim)}`);
  const initialSubject = 'CIM / NDA request for Acme Plumbing';
  const rendered = renderPursueCimEmail({ kind: followUp ? 'follow-up' : 'initial',
    followUpNumber: 1, deal: { name: 'Acme Plumbing', brokerName: 'Jordan Lee' },
    signature: fixtureSignature(), initialSubject });
  const message = {
    payloadVersion: followUp ? 'deal-hunter-cim-pursue-follow-up-v1'
      : 'deal-hunter-cim-pursue-initial-v2',
    fromAddress: SENDER, toAddresses: [BROKER], ccAddresses: [], bccAddresses: [],
    replyToAddress: SENDER, subject: rendered.subject, bodyText: rendered.text,
    bodyHtmlSanitized: rendered.html,
    tags: [`cim_touch_id=${ids.touchId}`,
      ...(followUp ? [`cim_in_reply_to=${cimRfcMessageId(`initial-${suffix}`, SENDER)}`] : [])],
  };
  const prepared = followUp
    ? await storage.prepareReservedCimFollowUp({ activationId: 'gmail-fl04c-followup',
      claimOwner: 'gmail-worker', recipientFingerprint, touchIds: [ids.touchId], claimTokenDigest,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      ...message, preparationGeneration: 1, actor: 'gmail-worker' })
    : await storage.prepareCimTransmission({ touchIds: [ids.touchId], claimTokenDigest,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      preparationGeneration: 1, ...message, actor: 'gmail-worker', now: '2026-09-29T15:31:00.000Z' });
  if (!prepared.prepared) throw new Error(`fixture preparation failed: ${JSON.stringify(prepared)}`);
  const transmission = prepared.transmission;
  const capability = followUp ? 'fl04c-followup' : 'fl04b-initial';
  const writerPath = followUp ? 'pursue-cim-follow-up' : 'pursue-cim-initial';
  const issued = await storage.issueCimLiveProviderAuthorization({
    id: `authorization-${suffix}`, activationId: `gmail-${capability}`, capability, writerPath,
    transmissionId: transmission.id, payloadDigest: transmission.payload_digest,
    recipientAuthorityDigest: recipientFingerprint, providerProfile: GMAIL_PROFILE,
    expiresAt: '2026-09-29T17:00:00.000Z', actor: 'fixture-owner',
    reason: 'synthetic Gmail final-gate envelope', now: '2026-09-29T15:45:00.000Z',
  });
  if (!issued.issued) throw new Error(`fixture authorization failed: ${JSON.stringify(issued)}`);
  const mailProvider = createFakeCimProvider({ now: GATE_NOW, senderAddress: SENDER });
  const config = gmailConfig();
  const loadMemberAuthority = async () => fixtureMemberAuthority(opportunityId);
  const readCurrentAuthority = async () => ({ opportunityId, blocked: false, blockers: [],
    opportunity: database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?')
      .get(opportunityId),
    sourceRows: database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
      WHERE opportunity_id = ? ORDER BY id`).all(opportunityId),
    sourceStates: database.prepare(`SELECT * FROM deal_hunter_source_freshness_state
      ORDER BY source_id`).all(),
    sourceHealth: { healthy: true, issues: [], requiredSources: ['sheet-0'] },
    identityExceptions: [] });
  const readProviderReadiness = ({ storage: readinessStorage, providerProfile, now }) =>
    readPursueCimProviderReadiness({ storage: readinessStorage, providerProfile, now,
      mailProvider, config });
  const gate = (overrides = {}) => authorizePreparedCimTransmission({ storage,
    transmissionId: transmission.id, authorizationId: issued.authorization.id, writerPath,
    providerProfile: GMAIL_PROFILE, actor: 'fixture-owner', now: GATE_NOW, loadMemberAuthority,
    readCurrentAuthority, readProviderReadiness, configOverride: config, ...overrides });
  return { storage, database, ids, transmission, authorization: issued.authorization,
    capability, writerPath, recipientFingerprint, mailProvider, config, gate,
    loadMemberAuthority, reservation: prepared.reservation ?? null };
}
