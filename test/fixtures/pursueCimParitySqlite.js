import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { authorizePreparedCimTransmission } from '../../server/services/pursueCimFinalGate.js';
import { createSqliteStorage } from '../../server/storage/sqlite.js';

const { now, commands, timezoneCommands, activationCommands, claimCommands,
  safetyRuns, ownerCommands, ownerStopCommands, campaignCommands, withdrawalCommand,
  parityRecipient } =
  JSON.parse(fs.readFileSync(0, 'utf8'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p1c-sqlite-parity-'));
const sqlitePath = path.join(directory, 'storage.sqlite');
const storage = createSqliteStorage({ storage: { sqlitePath },
  protection: { rateLimitRetentionMs: 0 } });
const database = new Database(sqlitePath);

database.prepare(`insert into deal_hunter_opportunities
  (opportunity_id, created_at, updated_at, canonical_name, identity_version)
  values ('opp-parity', ?, ?, 'Synthetic parity', 'cim-identity-v1')`).run(now, now);
database.prepare(`insert into deal_hunter_owner_decision_events
  (id, idempotency_key, request_digest, opportunity_id, action, actor,
   expected_discovery_revision, expected_material_revision, observed_discovery_revision,
   observed_material_revision, policy_version, created_at)
  values ('decision-parity', 'idem-parity', ?, 'opp-parity', 'pursue', 'fixture',
    0, 0, 0, 0, 'v1', ?)`).run('a'.repeat(64), now);
database.prepare(`insert into deal_hunter_pursuit_enrollments
  (id, decision_event_id, opportunity_id, state, reason_code, authority_digest,
   created_at, updated_at, row_version)
  values ('enrollment-parity', 'decision-parity', 'opp-parity', 'queued',
    'awaiting-orchestration', ?, ?, ?, 1)`).run('b'.repeat(64), now, now);

const expected = [];
for (const command of commands) {
  const outcome = await storage.transitionPursuitEnrollment(command);
  expected.push({ applied: outcome.applied, staleRevision: outcome.staleRevision,
    conflict: outcome.conflict, state: outcome.enrollment?.state ?? null,
    rowVersion: outcome.enrollment?.row_version ?? null });
  global.gc?.();
}
const expectedTimezone = [];
for (const command of timezoneCommands) {
  const outcome = await storage.appendOpportunityTimezoneRevision(command);
  expectedTimezone.push({ applied: outcome.applied, replay: outcome.replay,
    staleRevision: outcome.staleRevision,
    revision: outcome.timezoneRevision?.revision ?? null,
    state: outcome.timezoneRevision?.state ?? null });
  global.gc?.();
}
const timezoneAudit = database.prepare(`select id, authority_digest from deal_hunter_cim_audit_events
  where event_type = 'timezone-revision'`).get();
const expectedActivations = [];
for (const command of activationCommands) {
  const outcome = await storage.recordCimCapabilityActivation(command);
  expectedActivations.push({ applied: outcome.applied, replay: outcome.replay,
    conflict: outcome.conflict, blockedReason: outcome.blockedReason,
    id: outcome.activation?.id ?? null, status: outcome.activation?.status ?? null });
  global.gc?.();
}
database.prepare(`insert into deal_hunter_broker_conversations
  (id, recipient_authority_id, recipient_fingerprint, recipient_address,
   sender_policy_version, reply_policy_version, reply_alias_token_digest,
   rfc_thread_key, state, batching_policy_version, created_at, updated_at)
  values ('conversation-parity', 'recipient-authority', ?, 'broker@example.test',
    'sender-v1', 'reply-v1', ?, 'thread-parity', 'open', 'batching-off-v1', ?, ?)`)
  .run('e'.repeat(64), 'f'.repeat(64), now, now);
database.prepare(`insert into deal_hunter_cim_campaigns
  (id, opportunity_id, generation, enrollment_id, decision_event_id,
   policy_version, template_version, template_digest, permission_version,
   permission_digest, permission_revision, permission_scope, canonical_revision,
   crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
   freshness_authority_digest, discovery_revision, material_revision,
   timezone_revision, conversation_id, state, reason_code, created_at, updated_at)
  values ('campaign-parity', 'opp-parity', 1, 'enrollment-parity', 'decision-parity',
    'policy-v1', 'template-v1', ?, 'permission-v1', ?, 1, 'synthetic-cohort', 1,
    1, 'recipient-authority', ?, ?, 0, 0, 1, 'conversation-parity',
    'initial-pending', 'awaiting-window', ?, ?)`)
  .run('1'.repeat(64), '2'.repeat(64), 'e'.repeat(64), '3'.repeat(64), now, now);
database.prepare(`insert into deal_hunter_cim_campaign_touches
  (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at, due_local,
   timezone_revision, state, created_at, updated_at)
  values ('touch-parity', 'campaign-parity', 'opp-parity', 'initial', 'initial', 0,
    ?, '2026-09-25T12:00:00-07:00', 1, 'scheduled', ?, ?)`)
  .run(now, now, now);
const expectedClaims = [];
for (const command of claimCommands) {
  const outcome = await storage.claimDueCimTouch(command);
  expectedClaims.push({ claimed: outcome.claimed, alreadyOwned: outcome.alreadyOwned,
    staleAuthority: outcome.staleAuthority, terminal: outcome.terminal,
    conflict: outcome.conflict, state: outcome.touch?.state ?? null,
    rowVersion: outcome.touch?.row_version ?? null });
  global.gc?.();
}
database.prepare(`insert into deal_hunter_cim_requests
  (id, created_at, updated_at, deal_key, recipient_email, status,
   provider_message_id, request_state, delivery_state, metadata, opportunity_id)
  values ('legacy-parity', ?, ?, 'fingerprint:parity', 'broker@example.test', 'sent',
    'provider-legacy-parity', 'provider_accepted', 'accepted', '{}', 'opp-parity')`)
  .run(now, now);
const projection = await storage.readPursueCimProjection({ opportunityId: 'opp-parity' });
const expectedProjection = { decisionId: projection.decision?.id ?? null,
  enrollmentState: projection.enrollment?.state ?? null,
  campaignState: projection.campaign?.state ?? null,
  initialTouchState: projection.initialTouch?.state ?? null,
  transmissionId: projection.transmission?.id ?? null,
  legacySummary: projection.legacySummary, actions: projection.actions };
const expectedSafetyEmissions = [];
for (const run of safetyRuns) {
  expectedSafetyEmissions.push(await storage.appendCimSafetyEvents(run));
  global.gc?.();
}
const safetyEventId = database.prepare(`select id from deal_hunter_cim_safety_events
  where safety_run_id = 'safety-run-parity'`).get().id;
database.prepare(`insert into deal_hunter_opportunities
  (opportunity_id, created_at, updated_at, canonical_name, identity_version)
  values ('opp-decision', ?, ?, 'Synthetic decision', 'cim-identity-v1')`).run(now, now);
database.prepare(`insert into deal_hunter_opportunity_scores
  (opportunity_id, created_at, scored_at, deal_key, name, score_fingerprint,
   engine_version, rules_version, profile_version, completeness_policy_version,
   current_triage_eligible)
  values ('opp-decision', ?, ?, 'deal:opp-decision', 'Synthetic decision',
    'fingerprint:opp-decision', 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1', 1)`)
  .run(now, now);
const expectedOwnerDecisions = [];
for (const command of ownerCommands) {
  const outcome = await storage.recordOwnerDecision(command);
  expectedOwnerDecisions.push({ applied: outcome.applied, replay: outcome.replay,
    conflict: outcome.conflict, decisionId: outcome.decision?.id ?? null,
    enrollmentId: outcome.enrollment?.id ?? null,
    enrollmentState: outcome.enrollment?.state ?? null,
    scorePriority: database.prepare(`select operator_priority from deal_hunter_opportunity_scores
      where opportunity_id = 'opp-decision'`).get().operator_priority });
  global.gc?.();
}
database.prepare(`insert into deal_hunter_opportunity_scores
  (opportunity_id, created_at, scored_at, deal_key, name, score_fingerprint,
   engine_version, rules_version, profile_version, completeness_policy_version,
   current_triage_eligible)
  values ('opp-parity', ?, ?, 'deal:opp-parity', 'Synthetic parity',
    'fingerprint:opp-parity', 'engine-v1', 'rules-v1', 'profile-v1', 'complete-v1', 1)`)
  .run(now, now);
const expectedOwnerStops = [];
for (const command of ownerStopCommands) {
  const outcome = await storage.recordOwnerDecision(command);
  expectedOwnerStops.push({ applied: outcome.applied, replay: outcome.replay,
    conflict: outcome.conflict, decisionAction: outcome.decision?.action ?? null,
    enrollmentId: outcome.enrollment?.id ?? null,
    campaignState: database.prepare(`select state from deal_hunter_cim_campaigns
      where id = 'campaign-parity'`).get().state,
    touchState: database.prepare(`select state from deal_hunter_cim_campaign_touches
      where id = 'touch-parity'`).get().state,
    enrollmentState: database.prepare(`select state from deal_hunter_pursuit_enrollments
      where id = 'enrollment-parity'`).get().state,
    scorePriority: database.prepare(`select operator_priority from deal_hunter_opportunity_scores
      where opportunity_id = 'opp-parity'`).get().operator_priority,
    disposition: database.prepare(`select disposition from deal_hunter_dispositions
      where deal_key = 'deal:opp-parity'`).get()?.disposition ?? null });
  global.gc?.();
}
database.prepare(`insert into deal_hunter_opportunity_timezone_revisions
  (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
   evidence_digest, resolver_version, dataset_digest, actor, created_at)
  values ('opp-decision', 1, 'verified', 'America/Los_Angeles', 'operator-verified',
    'timezone-decision', ?, 'explicit-v1', ?, 'fixture', ?)`)
  .run('c'.repeat(64), 'd'.repeat(64), now);
database.prepare(`insert into contact_submissions
  (id, created_at, updated_at, status, delivery_provider, delivery_status,
   crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id)
  values ('11111111-1111-4111-8111-111111111111', ?, ?, 'open', 'none',
    'not-attempted', 'active', 'synthetic', 'synthetic-ip', 'Synthetic broker',
    'broker2@example.test', 'Synthetic owner', 'opp-decision')`).run(now, now);
database.prepare(`update deal_hunter_opportunities set primary_submission_id =
  '11111111-1111-4111-8111-111111111111' where opportunity_id = 'opp-decision'`).run();
const expectedCampaigns = [];
const crmMatchAuthorityFingerprint = await storage.readPursuitCrmMatchAuthorityFingerprint();
const resolvedCampaignCommands = campaignCommands.map((command) => ({ ...command,
  enrollmentId: expectedOwnerDecisions[0].enrollmentId,
  crmMatchAuthorityFingerprint,
  crmOwnershipRevision: database.prepare(`select revision from deal_hunter_crm_ownership_revisions
    where opportunity_id = 'opp-decision' order by revision desc limit 1`).get().revision,
  campaignAuthorityRevision: database.prepare(`select campaign_authority_revision as revision
    from deal_hunter_opportunities where opportunity_id = 'opp-decision'`).get().revision,
  globalAuthorityRevision: database.prepare(`select revision from deal_hunter_cim_global_authority
    where id = 'global'`).get().revision }));
for (const command of resolvedCampaignCommands) {
  const outcome = await storage.materializePursuitCampaign(command);
  expectedCampaigns.push({ applied: outcome.applied, existing: outcome.existing,
    actionRequired: outcome.actionRequired, campaignId: outcome.campaign?.id ?? null,
    campaignState: outcome.campaign?.state ?? null,
    expiryDerivation: outcome.campaign?.expiry_derivation ?? null,
    touchId: outcome.initialTouch?.id ?? null,
    touchState: outcome.initialTouch?.state ?? null });
  global.gc?.();
}
const materializedClaimCommand = { touchId: expectedCampaigns[0].touchId,
  expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
  expectedConversationTerminalRevision: 0, claimTokenDigest: '6'.repeat(64),
  claimOwner: 'materialize-fixture', claimExpiresAt: '2026-09-25T20:00:00.000Z', now };
const materializedClaim = await storage.claimDueCimTouch(materializedClaimCommand);
const expectedMaterializedClaim = { claimed: materializedClaim.claimed,
  state: materializedClaim.touch?.state ?? null };
const prepareBase = { touchIds: [expectedCampaigns[0].touchId],
  claimTokenDigest: '6'.repeat(64), expectedCampaignTerminalRevision: 0,
  expectedConversationTerminalRevision: 0, preparationGeneration: 1,
  payloadVersion: 'deal-hunter-cim-manual-stage1-v1', fromAddress: 'sender@example.test',
  toAddresses: ['broker2@example.test'], ccAddresses: [], bccAddresses: [],
  replyToAddress: 'reply@example.test', subject: 'Synthetic subject',
  bodyText: 'Synthetic body', bodyHtmlSanitized: '<p>Synthetic body</p>',
  tags: ['cim'], actor: 'fixture', now };
const prepareCommands = [prepareBase, { ...prepareBase },
  { ...prepareBase, subject: 'Changed subject' },
  { ...prepareBase, bodyText: 'Changed body' },
  { ...prepareBase, bodyHtmlSanitized: '<p>Changed body</p>' },
  { ...prepareBase, toAddresses: ['other@example.test'] },
  { ...prepareBase, ccAddresses: ['cc@example.test'] },
  { ...prepareBase, bccAddresses: ['bcc@example.test'] },
  { ...prepareBase, replyToAddress: 'other-reply@example.test' },
  { ...prepareBase, tags: ['changed=cim'] },
  { ...prepareBase, fromAddress: 'other-sender@example.test' },
  { ...prepareBase, payloadVersion: 'payload-v2' },
  { ...prepareBase, subject: 'Changed subject', preparationGeneration: 2 }];
const expectedPreparations = [];
for (const command of prepareCommands) {
  const outcome = await storage.prepareCimTransmission(command);
  expectedPreparations.push({ prepared: outcome.prepared, existing: outcome.existing,
    payloadConflict: outcome.payloadConflict, terminal: outcome.terminal,
    transmissionId: outcome.transmission?.id ?? null,
    transmissionState: outcome.transmission?.state ?? null,
    toAddresses: outcome.transmission?.to_addresses ?? null,
    generation: outcome.transmission?.preparation_generation ?? null });
  global.gc?.();
}
const preparedTransmission = database.prepare(`select * from deal_hunter_cim_transmissions
  where id = ?`).get(expectedPreparations.at(-1).transmissionId);
const authorizationBase = { id: 'authorization-materialize',
  activationId: 'activation-initial', capability: 'fl04b-initial',
  writerPath: 'pursue-cim-initial', transmissionId: preparedTransmission.id,
  payloadDigest: preparedTransmission.payload_digest,
  recipientAuthorityDigest: campaignCommands[0].recipientFingerprint,
  providerProfile: 'synthetic-provider',
  actor: 'fixture', reason: 'disposable authorization', now,
  expiresAt: '2026-09-25T20:00:00.000Z' };
const issueCommands = [authorizationBase, { ...authorizationBase },
  { ...authorizationBase, writerPath: 'different-writer' },
  { ...authorizationBase, id: 'authorization-other' }];
const expectedIssues = [];
for (const command of issueCommands) {
  const outcome = await storage.issueCimLiveProviderAuthorization(command);
  expectedIssues.push({ issued: outcome.issued, replay: outcome.replay,
    conflict: outcome.conflict, blockedReason: outcome.blockedReason,
    authorizationId: outcome.authorization?.id ?? null });
  global.gc?.();
}
database.prepare(`update deal_hunter_opportunities set discovery_state = 'known_prospective'
  where opportunity_id = 'opp-decision'`).run();
database.prepare(`insert into deal_hunter_source_freshness_state
  (source_id, next_generation, accepted_generation, accepted_run_id, accepted_digest,
   accepted_at, projection_state)
  values ('sheet-0', 1, 1, 'parity-run', ?, ?, 'accepted')`).run('5'.repeat(64), now);
database.prepare(`insert into deal_hunter_opportunity_source_observations
  (id, opportunity_id, source_id, source_name, source_record_id, field, value,
   observed_at, accepted_at, accepted_run_id, created_at, updated_at)
  values ('parity-source-row', 'opp-decision', 'sheet-0', 'Synthetic Sheet',
    'parity-record', 'broker_email', 'broker2@example.test', ?, ?, 'parity-run', ?, ?)`)
  .run(now, now, now, now);
const providerPendingCommands = [];
const finalGateStorage = { ...storage,
  authorizeCimProviderPending: async (command) => {
    providerPendingCommands.push(command);
    return storage.authorizeCimProviderPending(command);
  } };
const loadMemberAuthority = async () => ({ opportunityId: 'opp-decision',
  recipientOptions: [parityRecipient], materialsState: { materialsReceived: false,
    advancedBeyondBrokerOutreach: false, evidenceCodes: [] }, preparationBlockers: [],
  suppression: null, terminalReason: '', existingRequest: null, opportunityClaim: null,
  currentDispositionState: 'pursued', pursued: true });
const readCurrentAuthority = async () => ({ opportunityId: 'opp-decision', blocked: false,
  blockers: [], opportunity: database.prepare(`select * from deal_hunter_opportunities
    where opportunity_id = 'opp-decision'`).get(),
  sourceRows: database.prepare(`select * from deal_hunter_opportunity_source_observations
    where opportunity_id = 'opp-decision' order by id`).all(),
  sourceStates: database.prepare(`select * from deal_hunter_source_freshness_state
    order by source_id`).all(), sourceHealth: { healthy: true, issues: [],
    requiredSources: ['sheet-0'] }, identityExceptions: [] });
const readProviderReadiness = async () => ({ provider: 'resend',
  providerProfile: 'synthetic-provider', outboundConfigured: true, senderConfigured: true,
  senderAuthenticationAttested: true, webhookConfigured: true,
  requestReplyRoutingVerified: true, replyTrackingVerified: true,
  suppressionOperational: true, reconciliationOperational: true,
  evidenceRevision: 'parity-readiness', generatedAt: now,
  expiresAt: '2026-09-25T20:00:00.000Z' });
const gate = () => authorizePreparedCimTransmission({ storage: finalGateStorage,
  transmissionId: preparedTransmission.id, authorizationId: authorizationBase.id,
  writerPath: authorizationBase.writerPath, providerProfile: authorizationBase.providerProfile,
  actor: 'fixture', now, loadMemberAuthority, readCurrentAuthority, readProviderReadiness });
const expectedProviderPending = [];
for (let index = 0; index < 4; index += 1) {
  let outcome;
  if (index === 1) {
    const command = { ...providerPendingCommands[0], expectedRowVersion: 0 };
    providerPendingCommands.push(command);
    outcome = await storage.authorizeCimProviderPending(command);
  } else {
    if (index === 2) database.prepare(`insert into deal_hunter_cim_safety_settings
      (id, updated_at, outreach_paused, updated_by, metadata)
      values ('global', ?, 0, 'fixture', '{}')`).run(now);
    outcome = await gate();
  }
  expectedProviderPending.push({ authorized: outcome.authorized,
    blockedReason: outcome.blockedReason, transmissionState: outcome.transmission?.state ?? null,
    rowVersion: outcome.transmission?.row_version ?? null,
    boundaryNonceDigest: outcome.boundaryNonceDigest });
  global.gc?.();
}
const seamBase = { transmissionId: preparedTransmission.id,
  authorizationId: authorizationBase.id, writerPath: authorizationBase.writerPath,
  providerProfile: authorizationBase.providerProfile,
  capability: authorizationBase.capability, payloadDigest: preparedTransmission.payload_digest,
  boundaryNonceDigest: providerPendingCommands[2].boundaryNonceDigest, expectedRowVersion: 2,
  actor: 'fixture', now };
const seamCommands = [{ ...seamBase, boundaryNonceDigest: '9'.repeat(64) },
  { ...seamBase, payloadDigest: '9'.repeat(64) }, seamBase, seamBase];
const expectedSeam = [];
for (const command of seamCommands) {
  expectedSeam.push(await storage.enterCimProviderSeam(command));
  global.gc?.();
}
const finalizeBase = { transmissionId: preparedTransmission.id,
  payloadDigest: preparedTransmission.payload_digest,
  expectedRowVersion: 3, outcome: 'ambiguous', provider: 'resend',
  providerMessageId: null, providerResultCode: 'timeout', actor: 'fixture', now };
const finalizeCommands = [finalizeBase, { ...finalizeBase },
  { ...finalizeBase, providerResultCode: 'changed-result' }];
const expectedFinalizations = [];
for (const command of finalizeCommands) {
  const outcome = await storage.finalizeCimTransmission(command);
  expectedFinalizations.push({ applied: outcome.applied, existing: outcome.existing,
    conflict: outcome.conflict, transmissionState: outcome.transmission?.state ?? null,
    rowVersion: outcome.transmission?.row_version ?? null,
    nextTouchId: outcome.nextTouch?.id ?? null });
  global.gc?.();
}
const reconcileBase = { transmissionId: preparedTransmission.id,
  payloadDigest: preparedTransmission.payload_digest,
  expectedRowVersion: 4, outcome: 'definitive-failure',
  provider: 'resend', providerMessageId: null,
  providerResultCode: 'provider-confirmed-failure', evidenceType: 'operator-check',
  evidenceId: 'reconciliation-1', evidenceDigest: 'a'.repeat(64),
  actor: 'fixture', now };
const reconcileCommands = [reconcileBase, { ...reconcileBase },
  { ...reconcileBase, providerResultCode: 'changed-result' }];
const expectedReconciliations = [];
for (const command of reconcileCommands) {
  const outcome = await storage.reconcileCimTransmission(command);
  expectedReconciliations.push({ applied: outcome.applied, unchanged: outcome.unchanged,
    conflict: outcome.conflict, transmissionState: outcome.transmission?.state ?? null,
    rowVersion: outcome.transmission?.row_version ?? null });
  global.gc?.();
}
database.prepare(`insert into crm_communications
  (id, submission_id, opportunity_id, direction, channel, source, kind,
   idempotency_key, outbox_id, thread_key, from_address, to_addresses,
   cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
   body_html_sanitized, occurred_at, created_at, updated_at, metadata)
  select 'comm-withdraw', submission_id, opportunity_id, direction, channel, source,
    kind, 'comm-withdraw', 'outbox-withdraw', thread_key, from_address, to_addresses,
    cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
    body_html_sanitized, occurred_at, created_at, updated_at, metadata
  from crm_communications where id = ?`).run(preparedTransmission.communication_id);
database.prepare(`insert into crm_email_outbox
  (id, communication_id, submission_id, idempotency_key, client_request_key,
   state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
  select 'outbox-withdraw', 'comm-withdraw', submission_id, 'outbox-withdraw',
    'request-withdraw', 'prepared', 0, expected_submission_version, actor,
    created_at, updated_at, metadata from crm_email_outbox where id = ?`)
  .run(preparedTransmission.outbox_id);
database.prepare(`insert into deal_hunter_cim_transmissions
  (id, conversation_id, member_digest, preparation_generation, payload_version,
   payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
   reply_to_address, subject, provider_idempotency_key, communication_id,
   outbox_id, state, release_state, created_at, updated_at)
  select 'trans-withdraw', conversation_id, ?, 3, payload_version, payload_digest,
    from_address, to_addresses, cc_addresses, bcc_addresses, reply_to_address,
    subject, 'provider-key-withdraw', 'comm-withdraw', 'outbox-withdraw',
    'prepared', 'ordinary', created_at, updated_at
  from deal_hunter_cim_transmissions where id = ?`)
  .run('f'.repeat(64), preparedTransmission.id);
database.prepare(`insert into deal_hunter_cim_campaign_touches
  (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
   due_local, timezone_revision, state, claim_token_digest, claim_owner,
   claimed_at, claim_expires_at, transmission_id, created_at, updated_at)
  values ('touch-withdraw', ?, 'opp-decision', 'withdraw-slot', 'follow-up-1', 1,
    ?, '2026-09-25T12:00:00-07:00', 1, 'claimed', ?, 'fixture', ?,
    '2026-09-25T20:00:00.000Z', 'trans-withdraw', ?, ?)`)
  .run(expectedCampaigns[0].campaignId, now, '6'.repeat(64), now, now, now);
database.prepare(`insert into deal_hunter_cim_transmission_touches
  (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
  values ('trans-withdraw', 'touch-withdraw', 'opp-decision', ?, 1, ?)`)
  .run(expectedCampaigns[0].campaignId, now);
database.prepare(`insert into deal_hunter_cim_live_provider_authorizations
  (id, activation_id, capability, writer_path, transmission_id, payload_digest,
   recipient_authority_digest, provider_profile, maximum_calls, issued_at,
   expires_at, actor, reason)
  values ('authorization-withdraw', 'activation-initial', 'fl04b-initial',
    'withdraw-writer', 'trans-withdraw', ?, ?, 'synthetic-provider', 1, ?,
    '2026-09-25T20:00:00.000Z', 'fixture', 'synthetic withdrawal')`)
  .run(preparedTransmission.payload_digest, '8'.repeat(64), now);
const liveWithdrawalCommands = [
  { id: 'authorization-withdraw', actor: 'fixture', reason: 'withdraw fixture', now },
  { id: 'authorization-withdraw', actor: 'fixture', reason: 'withdraw fixture', now },
  { id: 'missing-authorization', actor: 'fixture', reason: 'withdraw fixture', now }];
const expectedLiveWithdrawals = [];
for (const command of liveWithdrawalCommands) {
  const outcome = await storage.withdrawCimLiveProviderAuthorization(command);
  expectedLiveWithdrawals.push({ applied: outcome.applied, replay: outcome.replay,
    conflict: outcome.conflict, authorizationId: outcome.authorization?.id ?? null,
    withdrawnAt: outcome.authorization?.withdrawn_at ?? null });
  global.gc?.();
}
const expectedWithdrawalState = {
  transmission: database.prepare(`select state from deal_hunter_cim_transmissions
    where id = 'trans-withdraw'`).get().state,
  touch: database.prepare(`select state from deal_hunter_cim_campaign_touches
    where id = 'touch-withdraw'`).get().state,
  membershipCancelled: database.prepare(`select cancelled_at from deal_hunter_cim_transmission_touches
    where transmission_id = 'trans-withdraw'`).get().cancelled_at !== null,
  outbox: database.prepare(`select state from crm_email_outbox
    where id = 'outbox-withdraw'`).get().state };
database.prepare(`insert into deal_hunter_cim_campaign_touches
  (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
   due_local, timezone_revision, state, created_at, updated_at)
  values ('touch-fence', ?, 'opp-decision', 'fence-slot', 'follow-up-1', 1,
    ?, '2026-09-25T12:00:00-07:00', 1, 'scheduled', ?, ?)`)
  .run(expectedCampaigns[0].campaignId, now, now, now);
const terminalConversation = database.prepare(`select conversation_id from deal_hunter_cim_campaigns
  where id = ?`).get(expectedCampaigns[0].campaignId).conversation_id;
const terminalConversationAuthority = database.prepare(`select terminal_revision, row_version
  from deal_hunter_broker_conversations where id = ?`).get(terminalConversation);
const terminalBase = { eventId: 'terminal-conversation', scope: 'conversation',
  scopeId: terminalConversation,
  expectedRevision: terminalConversationAuthority.terminal_revision,
  expectedRowVersion: terminalConversationAuthority.row_version, nextState: 'responded',
  reasonCode: 'broker-reply', evidenceType: 'synthetic-inbox', evidenceId: 'reply-1',
  metadataDigest: 'b'.repeat(64), actor: 'fixture', source: 'synthetic-inbox',
  observedAt: now, now };
const terminalCommands = [terminalBase, { ...terminalBase },
  { ...terminalBase, evidenceId: 'changed-evidence' }];
const expectedTerminals = [];
for (const command of terminalCommands) {
  const outcome = await storage.appendCimTerminalEvent(command);
  expectedTerminals.push({ applied: outcome.applied, replay: outcome.replay,
    conflict: outcome.conflict, campaignRevision: outcome.campaignRevision,
    conversationRevision: outcome.conversationRevision,
    cancelledTouchIds: outcome.cancelledTouchIds });
  global.gc?.();
}
const expectedTerminalState = {
  campaign: database.prepare(`select state from deal_hunter_cim_campaigns
    where id = ?`).get(expectedCampaigns[0].campaignId).state,
  touch: database.prepare(`select state from deal_hunter_cim_campaign_touches
    where id = 'touch-fence'`).get().state };
database.prepare(`insert into deal_hunter_opportunities
  (opportunity_id, created_at, updated_at, canonical_name, identity_version)
  values ('opp-safety', ?, ?, 'Synthetic safety', 'cim-identity-v1')`).run(now, now);
database.prepare(`insert into deal_hunter_owner_decision_events
  (id, idempotency_key, request_digest, opportunity_id, action, actor,
   expected_discovery_revision, expected_material_revision, observed_discovery_revision,
   observed_material_revision, policy_version, created_at)
  values ('decision-safety', 'key-safety', ?, 'opp-safety', 'pursue', 'fixture',
    0, 0, 0, 0, 'policy-v1', ?)`).run('a'.repeat(64), now);
database.prepare(`insert into deal_hunter_pursuit_enrollments
  (id, decision_event_id, opportunity_id, state, authority_digest, created_at, updated_at)
  values ('enrollment-safety', 'decision-safety', 'opp-safety', 'campaign-created', ?, ?, ?)`)
  .run('b'.repeat(64), now, now);
database.prepare(`insert into deal_hunter_opportunity_timezone_revisions
  (opportunity_id, revision, state, iana_timezone, evidence_type, evidence_id,
   evidence_digest, resolver_version, dataset_digest, actor, created_at)
  values ('opp-safety', 1, 'verified', 'America/Los_Angeles',
    'operator-verified', 'timezone-safety', ?, 'explicit-v1', ?, 'fixture', ?)`)
  .run('c'.repeat(64), 'd'.repeat(64), now);
database.prepare(`insert into deal_hunter_broker_conversations
  (id, recipient_authority_id, recipient_fingerprint, recipient_address,
   sender_policy_version, reply_policy_version, reply_alias_token_digest,
   rfc_thread_key, state, batching_policy_version, created_at, updated_at)
  values ('conversation-safety', 'recipient-safety', ?, 'safety@example.test',
    'sender-v1', 'reply-v1', ?, 'thread-safety', 'open', 'batching-off-v1', ?, ?)`)
  .run('8'.repeat(64), '0'.repeat(64), now, now);
database.prepare(`insert into deal_hunter_cim_campaigns
  (id, opportunity_id, generation, enrollment_id, decision_event_id,
   policy_version, template_version, template_digest, permission_version,
   permission_digest, permission_revision, permission_scope, canonical_revision,
   crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
   freshness_authority_digest, discovery_revision, material_revision,
   timezone_revision, conversation_id, state, reason_code, created_at, updated_at)
  values ('campaign-safety', 'opp-safety', 1, 'enrollment-safety', 'decision-safety',
    'policy-v1', 'template-v1', ?, 'permission-v1', ?, 1, 'synthetic-cohort', 1,
    1, 'recipient-safety', ?, ?, 0, 0, 1, 'conversation-safety',
    'initial-pending', 'awaiting-window', ?, ?)`)
  .run('1'.repeat(64), '2'.repeat(64), '8'.repeat(64), '3'.repeat(64), now, now);
database.prepare(`insert into crm_communications
  (id, submission_id, opportunity_id, direction, channel, source, kind,
   idempotency_key, outbox_id, thread_key, from_address, to_addresses,
   cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
   body_html_sanitized, occurred_at, created_at, updated_at, metadata)
  select 'comm-safety', submission_id, 'opp-safety', direction, channel, source,
    kind, 'comm-safety', 'outbox-safety', 'thread-safety', from_address, to_addresses,
    cc_addresses, bcc_addresses, reply_to_address, subject, body_text,
    body_html_sanitized, occurred_at, created_at, updated_at, metadata
  from crm_communications where id = ?`).run(preparedTransmission.communication_id);
database.prepare(`insert into crm_email_outbox
  (id, communication_id, submission_id, idempotency_key, client_request_key,
   state, attempt_count, expected_submission_version, actor, created_at, updated_at, metadata)
  select 'outbox-safety', 'comm-safety', submission_id, 'outbox-safety',
    'request-safety', 'prepared', 0, expected_submission_version, actor,
    created_at, updated_at, metadata from crm_email_outbox where id = ?`)
  .run(preparedTransmission.outbox_id);
database.prepare(`insert into deal_hunter_cim_transmissions
  (id, conversation_id, member_digest, preparation_generation, payload_version,
   payload_digest, from_address, to_addresses, cc_addresses, bcc_addresses,
   reply_to_address, subject, provider_idempotency_key, communication_id,
   outbox_id, state, release_state, created_at, updated_at)
  select 'trans-safety', 'conversation-safety', ?, 1, payload_version, payload_digest,
    from_address, to_addresses, cc_addresses, bcc_addresses, reply_to_address,
    subject, 'provider-key-safety', 'comm-safety', 'outbox-safety',
    'prepared', 'ordinary', created_at, updated_at
  from deal_hunter_cim_transmissions where id = ?`)
  .run('a'.repeat(64), preparedTransmission.id);
database.prepare(`insert into deal_hunter_cim_campaign_touches
  (id, campaign_id, opportunity_id, logical_slot, kind, ordinal, due_at,
   due_local, timezone_revision, state, claim_token_digest, claim_owner,
   claimed_at, claim_expires_at, transmission_id, created_at, updated_at)
  values ('touch-safety', 'campaign-safety', 'opp-safety', 'initial', 'initial', 0,
    ?, '2026-09-25T12:00:00-07:00', 1, 'claimed', ?, 'fixture', ?,
    '2026-09-25T20:00:00.000Z', 'trans-safety', ?, ?)`)
  .run(now, '6'.repeat(64), now, now, now);
database.prepare(`insert into deal_hunter_cim_transmission_touches
  (transmission_id, touch_id, opportunity_id, campaign_id, display_ordinal, created_at)
  values ('trans-safety', 'touch-safety', 'opp-safety', 'campaign-safety', 1, ?)`)
  .run(now);
database.prepare(`insert into deal_hunter_cim_live_provider_authorizations
  (id, activation_id, capability, writer_path, transmission_id, payload_digest,
   recipient_authority_digest, provider_profile, maximum_calls, issued_at,
   expires_at, actor, reason)
  values ('authorization-safety', 'activation-initial', 'fl04b-initial',
    'safety-writer', 'trans-safety', ?, ?, 'synthetic-provider', 1, ?,
    '2026-09-25T20:00:00.000Z', 'fixture', 'synthetic safety')`)
  .run(preparedTransmission.payload_digest, '8'.repeat(64), now);
const safetyStopRun = { safetyRunId: 'safety-run-stop', sourceType: 'synthetic-sheet',
  sourceRunId: 'source-run-stop', now,
  events: [{ opportunityId: 'opp-safety', canonicalRevision: 1,
    identityExceptionRevision: 0, eventType: 'source-stale', evidenceId: 'evidence-stop' }] };
await storage.appendCimSafetyEvents(safetyStopRun);
const safetyStopEventId = database.prepare(`select id from deal_hunter_cim_safety_events
  where safety_run_id = 'safety-run-stop'`).get().id;
const safetyConsumeCommands = [
  { safetyRunId: 'safety-run-stop', limit: 10, actor: 'fixture', now,
    outcomes: { [safetyStopEventId]: 'stopped' } },
  { safetyRunId: 'safety-run-stop', limit: 10, actor: 'fixture', now,
    outcomes: { [safetyStopEventId]: 'stopped' } },
  { safetyRunId: 'safety-run-parity', limit: 10, actor: 'fixture', now }];
const expectedSafetyConsumptions = [];
for (const command of safetyConsumeCommands) {
  expectedSafetyConsumptions.push(await storage.consumeCimSafetyEvents(command));
  global.gc?.();
}
const expectedSafetyStopState = {
  campaign: database.prepare(`select state from deal_hunter_cim_campaigns
    where id = 'campaign-safety'`).get().state,
  touch: database.prepare(`select state from deal_hunter_cim_campaign_touches
    where id = 'touch-safety'`).get().state,
  transmission: database.prepare(`select state from deal_hunter_cim_transmissions
    where id = 'trans-safety'`).get().state,
  authorizationWithdrawn: database.prepare(`select withdrawn_at from
    deal_hunter_cim_live_provider_authorizations where id = 'authorization-safety'`)
    .get().withdrawn_at !== null,
  outbox: database.prepare(`select state from crm_email_outbox
    where id = 'outbox-safety'`).get().state };
const expectedWithdrawals = [];
for (let index = 0; index < 2; index += 1) {
  const outcome = await storage.withdrawCimCapabilityActivation(withdrawalCommand);
  expectedWithdrawals.push({ applied: outcome.applied, replay: outcome.replay,
    conflict: outcome.conflict, status: outcome.activation?.status ?? null });
  global.gc?.();
}
database.close();
storage.close();
fs.rmSync(directory, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ expected, expectedTimezone, timezoneAudit,
  expectedActivations, expectedClaims, expectedProjection, expectedSafetyEmissions,
  safetyEventId, expectedOwnerDecisions, expectedOwnerStops, expectedCampaigns,
  resolvedCampaignCommands, materializedClaimCommand, expectedMaterializedClaim,
  prepareCommands, expectedPreparations, issueCommands, expectedIssues,
  providerPendingCommands, expectedProviderPending,
  seamCommands, expectedSeam,
  finalizeCommands, expectedFinalizations,
  reconcileCommands, expectedReconciliations,
  liveWithdrawalCommands, expectedLiveWithdrawals, expectedWithdrawalState,
  terminalCommands, expectedTerminals, expectedTerminalState,
  safetyStopRun, safetyStopEventId, safetyConsumeCommands,
  expectedSafetyConsumptions, expectedSafetyStopState,
  expectedWithdrawals }));
