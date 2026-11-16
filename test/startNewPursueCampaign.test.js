import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { recordAcquisitionOwnerCommand, startNewPursueCampaign } from '../server/services/dealHunterTriage.js';
import { orchestratePursuitEnrollment } from '../server/services/pursueCimEnrollment.js';
import { runDueCimInitialPreparations } from '../server/services/pursueCimInitialPreparation.js';
import { getPursueCimReleaseReport, stopPursueCimCampaign } from '../server/services/pursueCimRelease.js';
import { seedP4bEligibleFixture } from './fixtures/pursueCimEnrollmentFixture.js';

const healthy = async () => ({ healthy: true, issues: [] });
const restartAt = '2026-09-30T16:00:00.000Z';
const sendAt = '2026-10-06T18:00:00.000Z';
const noPause = async () => ({ paused: false });

// A listing with a generation-1 campaign on real SQLite, plus the initial-send activation.
async function campaignFixture(t) {
  const fixture = await seedP4bEligibleFixture(t);
  const { storage, opportunityId, now, decision } = fixture;
  const allocated = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: healthy });
  assert.equal(allocated.enrollment.state, 'campaign-created');
  const activated = await storage.recordCimCapabilityActivation({
    id: 'p4b-initial', capability: 'fl04b-initial', mode: 'active',
    policyHash: 'c'.repeat(64), configHash: 'd'.repeat(64), actor: 'fixture-owner',
    reason: 'synthetic only', confirmation: 'synthetic-confirmation', providerProfile: 'synthetic', now,
    prerequisiteActivationId: 'p4b-enrollment', prerequisiteEvidenceId: 'restart-initial-evidence',
    prerequisiteEvidenceHash: 'e'.repeat(64) });
  assert.equal(activated.applied, true);
  return { ...fixture, campaign: allocated.campaign };
}

async function stop(storage, opportunityId) {
  const { campaign } = await storage.readPursueCimProjection({ opportunityId });
  const result = await stopPursueCimCampaign({ storage, opportunityId, campaignId: campaign.id,
    expectedRowVersion: campaign.row_version, expectedTerminalRevision: campaign.terminal_revision,
    idempotencyKey: randomUUID(), reason: 'Stopped by mistake.', actor: 'fixture-owner',
    getPauseStatus: noPause });
  assert.equal(result.ok, true, result.error);
  return result.report;
}

const restartCommand = (opportunityId, report, extra = {}) => ({ opportunityId,
  campaignId: report.actions.newCampaign?.campaignId ?? report.campaign.id,
  expectedRowVersion: report.actions.newCampaign?.expectedRowVersion ?? report.campaign.rowVersion,
  idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
  actor: 'fixture-owner', policyVersion: 'owner-decision-v1', now: restartAt, ...extra });

const campaigns = (db) => db.prepare(`SELECT id, generation, state, conversation_id
  FROM deal_hunter_cim_campaigns ORDER BY generation`).all();

test('a campaign stopped before its email was prepared starts again as generation 2 and sends', async (t) => {
  const { storage, db, opportunityId } = await campaignFixture(t);
  const report = await stop(storage, opportunityId);
  assert.equal(report.actions.canStartNewCampaign, true);
  assert.equal(report.actions.newCampaign.nextGeneration, 2);

  const command = restartCommand(opportunityId, report);
  const recorded = await storage.startNewPursueCampaign(command);
  assert.equal(recorded.applied, true, recorded.reason);
  assert.equal(recorded.enrollment.restart_of_campaign_id, report.campaign.id);
  const replay = await storage.startNewPursueCampaign(command);
  assert.equal(replay.replay, true);
  assert.equal(replay.enrollment.id, recorded.enrollment.id);

  const enrolled = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: recorded.enrollment, decision: recorded.decision, actor: 'fixture-owner',
    now: restartAt, readSourceHealth: healthy });
  assert.equal(enrolled.enrollment.state, 'campaign-created', enrolled.enrollment.reason_code);
  const [first, second] = campaigns(db);
  assert.deepEqual([first.generation, first.state, second.generation, second.state],
    [1, 'stopped', 2, 'initial-pending']);
  assert.equal(second.conversation_id, first.conversation_id, 'the same broker keeps one conversation');

  const outcomes = await runDueCimInitialPreparations({ storage, now: sendAt });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].prepared, true, JSON.stringify(outcomes[0]));
  const transmission = db.prepare('SELECT * FROM deal_hunter_cim_transmissions').get();
  assert.equal(db.prepare(`SELECT campaign_id FROM deal_hunter_cim_transmission_touches
    WHERE transmission_id = ?`).get(transmission.id).campaign_id, second.id);
  const after = await getPursueCimReleaseReport({ storage, opportunityId, now: sendAt, getPauseStatus: noPause });
  assert.equal(after.campaign.generation, 2);
  assert.equal(after.actions.canStartNewCampaign, false);
});

test('a prepared email cancelled by Stop still allows a new campaign, which prepares its own', async (t) => {
  const { storage, db, opportunityId } = await campaignFixture(t);
  const prepared = await runDueCimInitialPreparations({ storage, now: restartAt });
  assert.equal(prepared[0]?.prepared, true, JSON.stringify(prepared));
  const report = await stop(storage, opportunityId);
  assert.equal(db.prepare('SELECT state FROM deal_hunter_cim_transmissions').get().state,
    'cancelled-before-provider');
  assert.equal(report.actions.canStartNewCampaign, true);
  const recorded = await storage.startNewPursueCampaign(restartCommand(opportunityId, report));
  assert.equal(recorded.applied, true, recorded.reason);
  const enrolled = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: recorded.enrollment, decision: recorded.decision, actor: 'fixture-owner',
    now: restartAt, readSourceHealth: healthy });
  assert.equal(enrolled.enrollment.state, 'campaign-created', enrolled.enrollment.reason_code);
  const outcomes = await runDueCimInitialPreparations({ storage, now: sendAt });
  assert.equal(outcomes[0]?.prepared, true, JSON.stringify(outcomes));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions
    WHERE state = 'prepared'`).get().n, 1);
});

test('no new campaign once an earlier email reached Google, and the send path refuses one too', async (t) => {
  const { storage, db, opportunityId } = await campaignFixture(t);
  const report = await stop(storage, opportunityId);
  const recorded = await storage.startNewPursueCampaign(restartCommand(opportunityId, report));
  await orchestratePursuitEnrollment({ storage, opportunityId, enrollment: recorded.enrollment,
    decision: recorded.decision, actor: 'fixture-owner', now: restartAt, readSourceHealth: healthy });
  assert.equal(campaigns(db).length, 2);
  // Simulate the race the backstop exists for: generation 1's email turns out to have reached Google.
  db.prepare(`UPDATE deal_hunter_cim_campaign_touches SET state = 'accepted'
    WHERE campaign_id = ?`).run(campaigns(db)[0].id);
  assert.deepEqual(await runDueCimInitialPreparations({ storage, now: sendAt }), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deal_hunter_cim_transmissions').get().n, 0);
});

test('Start a new campaign refuses an emailed campaign, a system stop, a stale row and a running campaign', async (t) => {
  const { storage, db, opportunityId } = await campaignFixture(t);
  const running = await getPursueCimReleaseReport({ storage, opportunityId, getPauseStatus: noPause });
  assert.equal(running.actions.canStartNewCampaign, false);
  assert.equal((await storage.startNewPursueCampaign(restartCommand(opportunityId, running))).reason,
    'campaign_not_restartable');

  const report = await stop(storage, opportunityId);
  assert.equal((await storage.startNewPursueCampaign(restartCommand(opportunityId, report,
    { expectedRowVersion: report.actions.newCampaign.expectedRowVersion + 1 }))).reason, 'campaign_changed');

  const campaignId = report.campaign.id;
  db.prepare(`UPDATE deal_hunter_cim_campaign_touches SET state = 'accepted' WHERE campaign_id = ?`)
    .run(campaignId);
  const emailed = await getPursueCimReleaseReport({ storage, opportunityId, getPauseStatus: noPause });
  assert.equal(emailed.actions.canStartNewCampaign, false);
  assert.equal((await storage.startNewPursueCampaign(restartCommand(opportunityId, report))).reason,
    'campaign_emailed');

  db.prepare(`UPDATE deal_hunter_cim_campaign_touches SET state = 'cancelled-before-provider'
    WHERE campaign_id = ?`).run(campaignId);
  db.prepare(`UPDATE deal_hunter_cim_campaigns SET reason_code = 'recipient_suppressed' WHERE id = ?`)
    .run(campaignId);
  assert.equal((await storage.startNewPursueCampaign(restartCommand(opportunityId, report))).reason,
    'campaign_not_restartable');
  assert.equal(campaigns(db).length, 1);
});

test('a plain Request SIM still never restarts a stopped campaign', async (t) => {
  const { storage, db, opportunityId } = await campaignFixture(t);
  await stop(storage, opportunityId);
  const decision = await storage.recordOwnerDecision({ opportunityId, action: 'watch',
    idempotencyKey: 'watch-before-pursue', actor: 'fixture-owner', policyVersion: 'owner-decision-v1',
    now: restartAt, expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 });
  assert.equal(decision.applied, true);
  const pursue = await storage.recordOwnerDecision({ opportunityId, action: 'pursue',
    idempotencyKey: 'plain-pursue', actor: 'fixture-owner', policyVersion: 'owner-decision-v1',
    now: restartAt, expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 });
  const enrolled = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: pursue.enrollment, decision: pursue.decision, actor: 'fixture-owner',
    now: restartAt, readSourceHealth: healthy });
  assert.equal(enrolled.enrollment.reason_code, 'prior_campaign_terminal');
  assert.equal(campaigns(db).length, 1);
});

test('the owner command records the choice even when enrollment has to wait', async (t) => {
  const { storage, db, opportunityId } = await campaignFixture(t);
  const report = await stop(storage, opportunityId);
  // The service reads real source health, which this fixture does not have, so enrollment waits.
  const result = await startNewPursueCampaign({ storage, opportunityId,
    campaignId: report.actions.newCampaign.campaignId,
    expectedRowVersion: report.actions.newCampaign.expectedRowVersion, idempotencyKey: randomUUID(),
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, actor: 'fixture-owner' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.notice.code, 'campaign_restart_waiting');
  const waiting = db.prepare(`SELECT * FROM deal_hunter_pursuit_enrollments WHERE state <> 'superseded'`).get();
  assert.equal(waiting.restart_of_campaign_id, report.campaign.id);
  // The daily re-evaluation of waiting enrollments then allocates generation 2.
  const decision = db.prepare('SELECT * FROM deal_hunter_owner_decision_events WHERE id = ?')
    .get(waiting.decision_event_id);
  const enrolled = await orchestratePursuitEnrollment({ storage, opportunityId, enrollment: waiting,
    decision, actor: 'fixture-owner', now: restartAt, readSourceHealth: healthy });
  assert.equal(enrolled.enrollment.state, 'campaign-created', enrolled.enrollment.reason_code);
  assert.equal(campaigns(db).at(-1).generation, 2);

  const refused = await startNewPursueCampaign({ storage, opportunityId,
    campaignId: report.campaign.id, expectedRowVersion: report.actions.newCampaign.expectedRowVersion,
    idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    actor: 'fixture-owner' });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'campaign_changed');
  const pursue = await recordAcquisitionOwnerCommand({ storage, opportunityId, action: 'pursue',
    idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    actor: 'fixture-owner' });
  assert.equal(pursue.notice?.code, 'campaign_running');
});
