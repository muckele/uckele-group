// Task 7: listing due Pursue follow-ups, the production follow-up preparation hooks, and a
// released follow-up being prepared again under the next generation and sent exactly once.
// Everything runs on real SQLite; only the Gmail mailbox is the fake provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { calculateCampaignExpiry } from '../server/services/cimCampaignPolicy.js';
import { authorizePreparedCimTransmission } from '../server/services/pursueCimFinalGate.js';
import {
  buildPursueFollowUpPayload,
  loadPursueFollowUpAuthority,
} from '../server/services/pursueCimFollowUpHooks.js';
import { runCimFollowUpPreparation } from '../server/services/pursueCimFollowUpPreparation.js';
import { finalizeAuthorizedCimTransmission } from '../server/services/pursueCimProvider.js';
import { readPursueCimProviderReadiness } from '../server/services/pursueCimReadiness.js';
import { renderPursueCimEmail } from '../server/services/pursueCimTemplates.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  BROKER,
  GATE_NOW,
  GMAIL_PROFILE,
  SENDER,
  SENDER_SETTINGS,
  createGmailGateFixture,
  fixtureMemberAuthority,
  gmailConfig,
  fixtureRecipientFingerprint,
  seedActivationChain,
  seedCampaign,
} from './fixtures/pursueCimGmailGateFixture.js';

const DAY = 24 * 60 * 60 * 1000;
const fill = (character) => character.repeat(64);
const wallNow = () => new Date().toISOString();
const row = (database, table, id) => database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
const CANDIDATE_KEYS = ['activation_id', 'campaignExpiryAt', 'campaign_id',
  'campaign_recipient_fingerprint', 'campaign_terminal_revision', 'claim_expires_at',
  'conversation_id', 'conversation_recipient_fingerprint', 'conversation_terminal_revision',
  'crm_submission_id', 'dueLocal', 'due_at', 'kind', 'opportunity_id', 'ordinal',
  'preparation_generation', 'recipient_address', 'recipient_fingerprint', 'row_version', 'state',
  'touch_id'];

function temporaryPath(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ug-${prefix}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'storage.sqlite');
}

/** A real-SQLite store with the activation chain and nothing else. */
async function listingStore(t) {
  const sqlitePath = temporaryPath(t, 'due-follow-ups');
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  await seedActivationChain(storage);
  const seed = (suffix, { followUp = true } = {}) => seedCampaign(database, suffix,
    fixtureRecipientFingerprint(`opp-gmail-${suffix}`), { followUp, now: wallNow() });
  return { storage, database, seed };
}

/**
 * A campaign whose initial was accepted through Gmail (real gate, real finalize, fake
 * mailbox), so its follow-up-1 touch exists. The fake mailbox accepts at the wall clock, which
 * the follow-up transitions and the capacity trigger also read, so the campaign window runs
 * from now; follow-up-1 (two business days out) is made due already.
 */
async function acceptedInitialCampaign(t, suffix) {
  const fixture = await createGmailGateFixture(t, suffix);
  const { database, ids } = fixture;
  const gate = await fixture.gate();
  assert.equal(gate.authorized, true, JSON.stringify(gate));
  const sent = await finalizeAuthorizedCimTransmission({ storage: fixture.storage,
    finalGateResult: gate, authorizationId: fixture.authorization.id,
    writerPath: fixture.writerPath, providerProfile: GMAIL_PROFILE, actor: 'pursue-cim-sender',
    now: new Date(GATE_NOW), configOverride: fixture.config, mailProvider: fixture.mailProvider });
  assert.equal(sent.outcome.category, 'accepted', JSON.stringify(sent.outcome));
  const followUpTouchId = sent.durableResult.nextTouch.id;
  assert.equal(Date.parse(row(database, 'deal_hunter_cim_campaigns', ids.campaignId)
    .local_expiry_at), Date.parse(calculateCampaignExpiry(row(database,
    'deal_hunter_cim_campaigns', ids.campaignId).initial_accepted_at, 'America/Los_Angeles',
    '08:00').expiresAt));
  // Due before the in-window instant the final gate runs at (GATE_NOW), as in the fixture.
  database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET due_at = ?, due_local = ?
    WHERE id = ?`).run('2026-09-29T15:00:00.000Z', '2026-09-29T08:00:00', followUpTouchId);
  const hooks = {
    loadAuthority: (input) => loadPursueFollowUpAuthority({ ...input, config: fixture.config,
      loadMemberAuthority: async ({ opportunityId }) => fixtureMemberAuthority(opportunityId) }),
    buildPayload: (input) => buildPursueFollowUpPayload({ ...input, config: fixture.config }),
  };
  return { ...fixture, initialTransmissionId: gate.transmission.id, followUpTouchId, hooks,
    initialSubject: row(database, 'deal_hunter_cim_transmissions', gate.transmission.id).subject };
}

async function dueCandidate(fixture) {
  const due = await fixture.storage.listDueCimFollowUpTouches({ now: wallNow() });
  const candidate = due.find((item) => item.touch_id === fixture.followUpTouchId);
  assert.ok(candidate, `follow-up ${fixture.followUpTouchId} is due: ${JSON.stringify(due)}`);
  return candidate;
}

async function prepareFollowUp(fixture, candidate, claimCharacter) {
  return runCimFollowUpPreparation({ storage: fixture.storage, candidate,
    clock: () => new Date(), actor: 'pursue-cim-follow-up-preparer',
    claimTokenDigest: fill(claimCharacter), ...fixture.hooks });
}

/** Issues the one-time authorization, runs the real gate and the Gmail send for a follow-up. */
async function sendFollowUp(fixture, transmission, attempt) {
  const minute = (offset) => new Date(Date.parse(GATE_NOW) + offset * 60_000).toISOString();
  const authorizationId = `authorization-follow-up-${attempt}`;
  const issued = await fixture.storage.issueCimLiveProviderAuthorization({ id: authorizationId,
    activationId: 'gmail-fl04c-followup', capability: 'fl04c-followup',
    writerPath: 'pursue-cim-follow-up', transmissionId: transmission.id,
    payloadDigest: transmission.payload_digest, recipientAuthorityDigest: fixture.recipientFingerprint,
    providerProfile: GMAIL_PROFILE, expiresAt: '2026-09-29T17:00:00.000Z', actor: 'fixture-owner',
    reason: 'follow-up send', now: minute(attempt * 2) });
  assert.equal(issued.issued, true, JSON.stringify(issued));
  const gateNow = minute(attempt * 2 + 1);
  const gate = await authorizePreparedCimTransmission({ storage: fixture.storage,
    transmissionId: transmission.id, authorizationId, writerPath: 'pursue-cim-follow-up',
    providerProfile: GMAIL_PROFILE, actor: 'fixture-owner', now: gateNow,
    loadMemberAuthority: fixture.loadMemberAuthority,
    readCurrentAuthority: async () => ({ opportunityId: fixture.ids.opportunityId, blocked: false,
      blockers: [], opportunity: fixture.database.prepare(`SELECT * FROM
        deal_hunter_opportunities WHERE opportunity_id = ?`).get(fixture.ids.opportunityId),
      sourceRows: fixture.database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
        WHERE opportunity_id = ? ORDER BY id`).all(fixture.ids.opportunityId),
      sourceStates: fixture.database.prepare(`SELECT * FROM deal_hunter_source_freshness_state
        ORDER BY source_id`).all(),
      sourceHealth: { healthy: true, issues: [], requiredSources: ['sheet-0'] },
      identityExceptions: [] }),
    readProviderReadiness: ({ storage, providerProfile, now }) => readPursueCimProviderReadiness({
      storage, providerProfile, now, mailProvider: fixture.mailProvider, config: fixture.config }),
    configOverride: fixture.config });
  assert.equal(gate.authorized, true, JSON.stringify(gate));
  return finalizeAuthorizedCimTransmission({ storage: fixture.storage, finalGateResult: gate,
    authorizationId, writerPath: 'pursue-cim-follow-up', providerProfile: GMAIL_PROFILE,
    actor: 'pursue-cim-sender', now: new Date(gateNow), configOverride: fixture.config,
    mailProvider: fixture.mailProvider });
}

/** Moves the campaign's expiry, keeping its stamped expiry derivation bound to it. */
function setCampaignExpiry(database, campaignId, expiresAt) {
  const derivation = JSON.parse(row(database, 'deal_hunter_cim_campaigns', campaignId)
    .expiry_derivation);
  database.prepare(`UPDATE deal_hunter_cim_campaigns SET local_expiry_at = ?,
    expiry_derivation = ? WHERE id = ?`).run(expiresAt,
    JSON.stringify({ ...derivation, expiresAt }), campaignId);
}

/** One follow-up a day and one per recipient: a slot that still counted would block. */
function tightCapacity(database) {
  database.prepare(`UPDATE deal_hunter_cim_capability_activations SET daily_cap = 1,
    recipient_cap = 1 WHERE id = 'gmail-fl04c-followup'`).run();
}

test('lists only due scheduled follow-up touches of active campaigns', async (t) => {
  const { storage, database, seed } = await listingStore(t);
  const due = seed('due');
  const later = seed('later');
  database.prepare('UPDATE deal_hunter_cim_campaign_touches SET due_at = ? WHERE id = ?')
    .run(new Date(Date.now() + 2 * DAY).toISOString(), later.touchId);
  const lapsed = seed('lapsed');
  database.prepare('UPDATE deal_hunter_cim_campaigns SET local_expiry_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), lapsed.campaignId);

  const now = wallNow();
  const listed = await storage.listDueCimFollowUpTouches({ now });
  assert.deepEqual(listed.map((candidate) => candidate.touch_id), [due.touchId]);
  const [candidate] = listed;
  assert.deepEqual(Object.keys(candidate).sort(), CANDIDATE_KEYS);
  const campaign = row(database, 'deal_hunter_cim_campaigns', due.campaignId);
  assert.deepEqual({ ...candidate }, {
    touch_id: due.touchId, campaign_id: due.campaignId, opportunity_id: due.opportunityId,
    conversation_id: due.conversationId, kind: 'follow-up-1', ordinal: 1, state: 'scheduled',
    due_at: '2026-09-29T15:00:00.000Z', dueLocal: '2026-09-29T08:00:00-07:00', row_version: 1,
    claim_expires_at: null, campaign_terminal_revision: 0, conversation_terminal_revision: 0,
    crm_submission_id: due.submissionId, recipient_address: BROKER,
    recipient_fingerprint: fixtureRecipientFingerprint(due.opportunityId),
    campaign_recipient_fingerprint: fixtureRecipientFingerprint(due.opportunityId),
    conversation_recipient_fingerprint: fixtureRecipientFingerprint(due.opportunityId),
    campaignExpiryAt: campaign.local_expiry_at, activation_id: 'gmail-fl04c-followup',
    preparation_generation: 1,
  });
  // The later touch becomes due once its time has come.
  const afterLater = new Date(Date.now() + 3 * DAY).toISOString();
  assert.deepEqual((await storage.listDueCimFollowUpTouches({ now: afterLater }))
    .map((item) => item.touch_id).sort(), [due.touchId, later.touchId].sort());
  assert.equal((await storage.listDueCimFollowUpTouches({ now: afterLater, limit: 1 })).length, 1);
  await assert.rejects(storage.listDueCimFollowUpTouches({ now, limit: 0 }), /limit/i);
  await assert.rejects(storage.listDueCimFollowUpTouches({ now: 'not-a-time' }), /instant|time/i);
  // Without a current fl04c-followup activation nothing is due.
  database.prepare(`UPDATE deal_hunter_cim_capability_activations SET mode = 'shadow'
    WHERE id = 'gmail-fl04c-followup'`).run();
  assert.deepEqual(await storage.listDueCimFollowUpTouches({ now }), []);
});

test('excludes initial, claimed, cancelled, and terminal-campaign touches', async (t) => {
  const { storage, database, seed } = await listingStore(t);
  const due = seed('due');
  seed('initial', { followUp: false });
  const claimed = seed('claimed');
  const now = wallNow();
  const claim = await storage.claimDueCimTouch({ touchId: claimed.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest: fill('c'), claimOwner: 'another-worker',
    claimExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), now });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const lapsedClaim = seed('lapsed-claim');
  assert.equal((await storage.claimDueCimTouch({ touchId: lapsedClaim.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: fill('d'),
    claimOwner: 'crashed-worker', claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    now })).claimed, true);
  database.prepare('UPDATE deal_hunter_cim_campaign_touches SET claim_expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), lapsedClaim.touchId);
  const cancelled = seed('cancelled');
  database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET state = 'cancelled-before-provider'
    WHERE id = ?`).run(cancelled.touchId);
  for (const [suffix, campaignState, conversationState] of [
    ['responded', 'responded', 'responded'], ['expired', 'expired', 'closed'],
    ['action-required', 'action-required', 'open'], ['ambiguous', 'provider-ambiguous', 'open'],
    ['conversation-closed', 'active-follow-up', 'closed'],
  ]) {
    const ids = seed(suffix);
    database.prepare('UPDATE deal_hunter_cim_campaigns SET state = ? WHERE id = ?')
      .run(campaignState, ids.campaignId);
    database.prepare('UPDATE deal_hunter_broker_conversations SET state = ? WHERE id = ?')
      .run(conversationState, ids.conversationId);
  }
  assert.deepEqual((await storage.listDueCimFollowUpTouches({ now: wallNow() }))
    .map((candidate) => candidate.touch_id), [due.touchId]);
});

test('payload marks the last follow-up before expiry as Final', async (t) => {
  const fixture = await acceptedInitialCampaign(t, 'final');
  const { database, ids, storage } = fixture;
  const deal = { name: 'Acme Plumbing', brokerName: 'Jordan' };
  const build = async () => {
    const now = wallNow();
    const candidate = await dueCandidate(fixture);
    const authority = await fixture.hooks.loadAuthority({ candidate, storage, now });
    return fixture.hooks.buildPayload({ candidate, authority, storage, now });
  };

  // Weeks remain before expiry: follow-up 1 is variant A.
  const regular = await build();
  const variantA = renderPursueCimEmail({ kind: 'follow-up', followUpNumber: 1, deal,
    sender: SENDER_SETTINGS, initialSubject: fixture.initialSubject });
  assert.equal(regular.isFinal, false);
  assert.equal(regular.bodyText, variantA.text);
  assert.equal(regular.bodyHtmlSanitized, variantA.html);

  // The next slot (two business days on) would land after expiry: this one is Final.
  setCampaignExpiry(database, ids.campaignId, new Date(Date.now() + DAY).toISOString());
  const final = await build();
  const finalCopy = renderPursueCimEmail({ kind: 'follow-up', followUpNumber: 1, isFinal: true,
    deal, sender: SENDER_SETTINGS, initialSubject: fixture.initialSubject });
  assert.equal(final.isFinal, true);
  assert.equal(final.bodyText, finalCopy.text);
  assert.match(final.bodyText, /This is my last note on Acme Plumbing\./);
  assert.equal(final.subject, regular.subject);
});

test('payload threads to the initial Message-ID', async (t) => {
  const fixture = await acceptedInitialCampaign(t, 'threading');
  const { storage, ids } = fixture;
  const now = wallNow();
  const candidate = await dueCandidate(fixture);
  const authority = await fixture.hooks.loadAuthority({ candidate, storage, now });
  const payload = await fixture.hooks.buildPayload({ candidate, authority, storage, now });
  const initialMessageId = `<${fixture.initialTransmissionId}@uckele.example.test>`;
  assert.equal(fixture.initialSubject, 'CIM / NDA request for Acme Plumbing');
  assert.deepEqual({ payloadVersion: payload.payloadVersion, fromAddress: payload.fromAddress,
    toAddresses: payload.toAddresses, ccAddresses: payload.ccAddresses,
    bccAddresses: payload.bccAddresses, replyToAddress: payload.replyToAddress,
    subject: payload.subject, inReplyTo: payload.inReplyTo, references: payload.references },
  { payloadVersion: 'deal-hunter-cim-pursue-follow-up-v1', fromAddress: SENDER,
    toAddresses: [BROKER], ccAddresses: [], bccAddresses: [], replyToAddress: SENDER,
    subject: 'Re: CIM / NDA request for Acme Plumbing', inReplyTo: initialMessageId,
    references: [initialMessageId] });
  assert.deepEqual(payload.tags, [
    `cim_conversation_id=${ids.conversationId}`,
    `cim_touch_id=${candidate.touch_id}`,
    'cim_template=pursue-cim-follow-up-v1',
    `cim_in_reply_to=${initialMessageId}`,
  ]);

  // Without an accepted initial there is nothing to reply to: the authority is unavailable,
  // and the builder still refuses defensively.
  const orphan = await createGmailGateFixture(t, 'orphan', { kind: 'follow-up' });
  assert.equal(await loadPursueFollowUpAuthority({ candidate: { touch_id: orphan.ids.touchId },
    storage: orphan.storage, now, config: orphan.config,
    loadMemberAuthority: async ({ opportunityId }) => fixtureMemberAuthority(opportunityId) }),
  null);
  await assert.rejects(buildPursueFollowUpPayload({ candidate, authority: { ...authority,
    initial: null }, storage, now, config: fixture.config }), /pursue_follow_up_initial_unavailable/);
});

test('anything the payload would reject stops the follow-up before it is claimed', async (t) => {
  const unclaimed = async (fixture, candidate, { storage = fixture.storage,
    config = fixture.config } = {}) => {
    const before = row(fixture.database, 'deal_hunter_cim_campaign_touches', candidate.touch_id);
    const result = await runCimFollowUpPreparation({ storage, candidate, clock: () => new Date(),
      claimTokenDigest: fill('9'),
      loadAuthority: (input) => loadPursueFollowUpAuthority({ ...input, config,
        loadMemberAuthority: async ({ opportunityId }) => fixtureMemberAuthority(opportunityId) }),
      buildPayload: (input) => buildPursueFollowUpPayload({ ...input, config }) });
    assert.deepEqual({ prepared: result.prepared, blockedReason: result.blockedReason,
      claim: result.claim }, { prepared: false, blockedReason: 'authority_unavailable',
      claim: undefined });
    const after = row(fixture.database, 'deal_hunter_cim_campaign_touches', candidate.touch_id);
    assert.deepEqual({ state: after.state, claim: after.claim_token_digest,
      owner: after.claim_owner, rowVersion: after.row_version, transmission: after.transmission_id },
    { state: 'scheduled', claim: null, owner: null, rowVersion: before.row_version,
      transmission: null });
  };

  // No accepted initial to reply to.
  const { storage, database, seed } = await listingStore(t);
  const orphan = seed('no-initial');
  const [orphanCandidate] = (await storage.listDueCimFollowUpTouches({ now: wallNow() }))
    .filter((item) => item.touch_id === orphan.touchId);
  await unclaimed({ storage, database, config: gmailConfig() }, orphanCandidate);

  // The initial's Message-ID would be unsafe in a header (its sender has no usable domain).
  const unsafe = await acceptedInitialCampaign(t, 'unsafe-message-id');
  const unsafeStorage = Object.create(unsafe.storage, { readCimFollowUpAuthority: { value:
    async (command) => {
      const durable = await unsafe.storage.readCimFollowUpAuthority(command);
      return { ...durable, initial: { ...durable.initial, fromAddress: 'owner@localhost' } };
    } } });
  await unclaimed(unsafe, await dueCandidate(unsafe), { storage: unsafeStorage });

  // The provider profile is not Gmail, or Gmail has no sender address.
  const resend = await acceptedInitialCampaign(t, 'not-gmail');
  await unclaimed(resend, await dueCandidate(resend), { config: gmailConfig({ provider: 'resend' }) });
  const noSender = gmailConfig();
  noSender.dealHunter.cimProvider.gmailSenderAddress = '';
  await unclaimed(resend, await dueCandidate(resend), { config: noSender });

  // The campaign cadence cannot say whether this is the Final follow-up.
  const cadence = await acceptedInitialCampaign(t, 'cadence');
  const derivation = JSON.parse(row(cadence.database, 'deal_hunter_cim_campaigns',
    cadence.ids.campaignId).expiry_derivation);
  for (const broken of [
    { ...derivation, cadencePolicyVersion: 'deal-hunter-cim-cadence-v9' },
    { ...derivation, policyVersion: 'another-policy' },
    { ...derivation, sendTime: undefined },
    { ...derivation, expiresAt: new Date(Date.now() + DAY).toISOString() },
    { ...derivation, sourceAcceptedAt: new Date(Date.now() - DAY).toISOString() },
    {},
  ]) {
    cadence.database.prepare(`UPDATE deal_hunter_cim_campaigns SET expiry_derivation = ?
      WHERE id = ?`).run(JSON.stringify(broken), cadence.ids.campaignId);
    await unclaimed(cadence, await dueCandidate(cadence));
  }
  // Restored, the same touch is claimed and prepared.
  cadence.database.prepare(`UPDATE deal_hunter_cim_campaigns SET expiry_derivation = ?
    WHERE id = ?`).run(JSON.stringify(derivation), cadence.ids.campaignId);
  const prepared = await prepareFollowUp(cadence, await dueCandidate(cadence), '1');
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
});

test('follow-up authority reads the durable touch, campaign, chain and stop signals', async (t) => {
  const fixture = await acceptedInitialCampaign(t, 'authority');
  const { storage, database, ids } = fixture;
  const now = wallNow();
  const candidate = await dueCandidate(fixture);
  const authority = await fixture.hooks.loadAuthority({ candidate, storage, now });
  assert.equal(authority.touch.id, candidate.touch_id);
  assert.equal(authority.touch.kind, 'follow-up-1');
  assert.equal(authority.campaign.id, ids.campaignId);
  assert.equal(authority.conversation.id, ids.conversationId);
  assert.equal(authority.opportunity.opportunity_id, ids.opportunityId);
  assert.equal(authority.crmSubmission.id, ids.submissionId);
  assert.equal(authority.crmOwnership.submission_id, ids.submissionId);
  assert.equal(authority.activation.id, 'gmail-fl04c-followup');
  assert.equal(authority.timezone.iana_timezone, 'America/Los_Angeles');
  assert.deepEqual(authority.recipient, { address: BROKER,
    fingerprint: fixtureRecipientFingerprint(ids.opportunityId), firstName: 'Jordan',
    displayName: 'Jordan Lee' });
  assert.deepEqual(authority.initial, { transmissionId: fixture.initialTransmissionId,
    fromAddress: SENDER, subject: 'CIM / NDA request for Acme Plumbing' });
  assert.deepEqual(authority.terminal, { replyReceived: false, materialsReceived: false,
    advancedDiligence: false, suppressed: false, unsafeDelivery: false, providerPending: false,
    providerAmbiguous: false });

  // Stop signals come from durable records.
  database.prepare(`INSERT INTO email_suppressions (id, normalized_email, reason, source,
    created_at, created_by) VALUES ('suppression-1', lower(?), 'unsubscribe', 'test', ?, 'test')`)
    .run(BROKER, now);
  database.prepare(`INSERT INTO crm_communications (id, submission_id, opportunity_id, direction,
    channel, source, kind, idempotency_key, thread_key, from_address, to_addresses, cc_addresses,
    bcc_addresses, reply_to_address, subject, body_text, body_html_sanitized, occurred_at,
    created_at, updated_at, metadata) VALUES ('inbound-1', ?, ?, 'inbound', 'email', 'test',
    'broker-reply', 'inbound-1', ?, ?, ?, '[]', '[]', '', 'Re: hi', 'thanks', '', ?, ?, ?, '{}')`)
    .run(ids.submissionId, ids.opportunityId, `thread-${'authority'}`, BROKER,
      JSON.stringify([SENDER]), now, now, now);
  const stopped = await fixture.hooks.loadAuthority({ candidate, storage, now });
  assert.equal(stopped.terminal.suppressed, true);
  assert.equal(stopped.terminal.replyReceived, true);
  // A touch that does not exist has no authority.
  assert.equal(await fixture.hooks.loadAuthority({ candidate: { touch_id: 'missing' }, storage,
    now }), null);
});

test('a released follow-up is listed under generation 2, prepared again and sent exactly once', async (t) => {
  const fixture = await acceptedInitialCampaign(t, 'reprepare');
  const { database, storage, mailProvider, ids } = fixture;
  tightCapacity(database);
  const initialSends = mailProvider.sent.length;

  const first = await dueCandidate(fixture);
  assert.equal(first.preparation_generation, 1);
  const prepared = await prepareFollowUp(fixture, first, '1');
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
  assert.equal(prepared.transmission.preparation_generation, 1);

  // Gmail refuses before acceptance: the touch is released back to scheduled.
  mailProvider.quotaNext();
  const quota = await sendFollowUp(fixture, prepared.transmission, 1);
  assert.equal(quota.outcome.category, 'unsent', JSON.stringify(quota.outcome));
  assert.equal(mailProvider.sent.length, initialSends);
  assert.equal(row(database, 'deal_hunter_cim_campaign_touches', first.touch_id).state, 'scheduled');
  // The released transmission keeps its consumed reservation as evidence ...
  assert.equal(database.prepare(`SELECT state FROM deal_hunter_cim_capacity_reservations
    WHERE transmission_id = ?`).get(prepared.transmission.id).state, 'consumed');

  // ... but the slot no longer counts: the same touch is prepared again under generation 2
  // although only one follow-up a day and one per recipient is allowed.
  const second = await dueCandidate(fixture);
  assert.equal(second.touch_id, first.touch_id);
  assert.equal(second.preparation_generation, 2);
  const reprepared = await prepareFollowUp(fixture, second, '2');
  assert.equal(reprepared.prepared, true, JSON.stringify(reprepared));
  assert.equal(reprepared.transmission.preparation_generation, 2);
  assert.notEqual(reprepared.transmission.id, prepared.transmission.id);
  assert.equal(reprepared.reservation.state, 'reserved');

  const accepted = await sendFollowUp(fixture, reprepared.transmission, 2);
  assert.equal(accepted.outcome.category, 'accepted', JSON.stringify(accepted.outcome));
  assert.equal(mailProvider.sent.length, initialSends + 1, 'exactly one follow-up reached Gmail');
  const sent = mailProvider.sent.at(-1);
  assert.equal(sent.rfcMessageId, `<${reprepared.transmission.id}@uckele.example.test>`);
  assert.equal(sent.inReplyTo, `<${fixture.initialTransmissionId}@uckele.example.test>`);
  assert.equal(sent.threadId, row(database, 'deal_hunter_broker_conversations',
    ids.conversationId).gmail_thread_id);
  assert.equal(sent.subject, 'Re: CIM / NDA request for Acme Plumbing');
  assert.equal(row(database, 'deal_hunter_cim_campaign_touches', first.touch_id).state, 'accepted');
  assert.equal(accepted.durableResult.nextTouch.kind, 'follow-up-2');
  assert.deepEqual(database.prepare(`SELECT preparation_generation AS generation, state
    FROM deal_hunter_cim_transmissions t JOIN deal_hunter_cim_transmission_touches m
      ON m.transmission_id = t.id WHERE m.touch_id = ? ORDER BY generation`).all(first.touch_id)
    .map((item) => ({ ...item })),
  [{ generation: 1, state: 'cancelled-before-provider' }, { generation: 2, state: 'accepted' }]);
  // The accepted touch is never due again, and the old transmission cannot be authorized.
  assert.ok(!(await storage.listDueCimFollowUpTouches({ now: wallNow() }))
    .some((item) => item.touch_id === first.touch_id));
  const stale = await storage.issueCimLiveProviderAuthorization({ id: 'authorization-stale',
    activationId: 'gmail-fl04c-followup', capability: 'fl04c-followup',
    writerPath: 'pursue-cim-follow-up', transmissionId: prepared.transmission.id,
    payloadDigest: prepared.transmission.payload_digest,
    recipientAuthorityDigest: fixture.recipientFingerprint, providerProfile: GMAIL_PROFILE,
    expiresAt: '2026-09-29T17:00:00.000Z', actor: 'fixture-owner', reason: 'stale retry',
    now: '2026-09-29T16:20:00.000Z' });
  assert.equal(stale.issued, false);
});

test('a re-prepared follow-up checks its generation and renews a lapsed reservation', async (t) => {
  const fixture = await acceptedInitialCampaign(t, 'renew');
  const { database, storage, mailProvider } = fixture;
  tightCapacity(database);
  const initialSends = mailProvider.sent.length;
  const prepared = await prepareFollowUp(fixture, await dueCandidate(fixture), '1');
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
  mailProvider.quotaNext();
  assert.equal((await sendFollowUp(fixture, prepared.transmission, 1)).outcome.category, 'unsent');

  const candidate = await dueCandidate(fixture);
  assert.equal(candidate.preparation_generation, 2);
  const claim = await storage.claimDueCimTouch({ touchId: candidate.touch_id,
    expectedRowVersion: Number(candidate.row_version), expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: fill('2'),
    claimOwner: 'pursue-cim-follow-up-preparer',
    claimExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), now: wallNow() });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const now = wallNow();
  const authority = await fixture.hooks.loadAuthority({ candidate, storage, now });
  const payload = await fixture.hooks.buildPayload({ candidate, authority, storage, now });
  const message = Object.fromEntries(['payloadVersion', 'fromAddress', 'toAddresses',
    'ccAddresses', 'bccAddresses', 'replyToAddress', 'subject', 'bodyText',
    'bodyHtmlSanitized', 'tags'].map((field) => [field, payload[field]]));
  const command = (preparationGeneration) => ({ activationId: 'gmail-fl04c-followup',
    claimOwner: 'pursue-cim-follow-up-preparer', recipientFingerprint: fixture.recipientFingerprint,
    touchIds: [candidate.touch_id], claimTokenDigest: fill('2'),
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0, ...message,
    preparationGeneration, actor: 'pursue-cim-follow-up-preparer' });
  for (const generation of [1, 3]) {
    const refused = await storage.prepareReservedCimFollowUp(command(generation));
    assert.deepEqual({ prepared: refused.prepared, blockedReason: refused.blockedReason },
      { prepared: false, blockedReason: 'preparation_generation_invalid' }, `generation ${generation}`);
  }
  const reprepared = await storage.prepareReservedCimFollowUp(command(2));
  assert.equal(reprepared.prepared, true, JSON.stringify(reprepared));
  assert.equal((await storage.prepareReservedCimFollowUp(command(2))).existing, true);

  // The lease lapses before the gate: the same generation-2 transmission is renewed.
  const lapsedAt = new Date(Date.now() - 1000).toISOString();
  database.prepare(`UPDATE deal_hunter_cim_capacity_reservations SET state = 'expired',
    expired_at = ?, row_version = row_version + 1 WHERE id = ?`)
    .run(lapsedAt, reprepared.reservation.id);
  database.prepare('UPDATE deal_hunter_cim_campaign_touches SET claim_expires_at = ? WHERE id = ?')
    .run(lapsedAt, candidate.touch_id);
  const renewed = await storage.renewReservedCimFollowUp({
    transmissionId: reprepared.transmission.id, touchId: candidate.touch_id,
    activationId: 'gmail-fl04c-followup', recipientFingerprint: fixture.recipientFingerprint,
    expectedRowVersion: row(database, 'deal_hunter_cim_campaign_touches', candidate.touch_id)
      .row_version, claimTokenDigest: fill('3'), claimOwner: 'pursue-cim-follow-up-preparer',
    claimExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    actor: 'pursue-cim-follow-up-preparer' });
  assert.equal(renewed.renewed, true, JSON.stringify(renewed));
  assert.equal(renewed.transmission.id, reprepared.transmission.id);
  assert.equal(renewed.transmission.preparation_generation, 2);

  const accepted = await sendFollowUp(fixture, reprepared.transmission, 2);
  assert.equal(accepted.outcome.category, 'accepted', JSON.stringify(accepted.outcome));
  assert.equal(mailProvider.sent.length, initialSends + 1);
});
