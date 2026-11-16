import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getTriageOpportunityDetail, publicTriageRow,
  recordAcquisitionOwnerCommand, requestSimNotice } from '../server/services/dealHunterTriage.js';
import { orchestratePursuitEnrollment } from '../server/services/pursueCimEnrollment.js';
import { publicCampaignSummary } from '../server/services/pursueCimCampaignSummary.js';
import { stopPursueCimCampaign } from '../server/services/pursueCimRelease.js';
import { seedP4bEligibleFixture } from './fixtures/pursueCimEnrollmentFixture.js';

const healthy = async () => ({ healthy: true, issues: [] });

// One listing with a scheduled campaign on real SQLite: generation 1, nothing sent.
async function campaignFixture(t) {
  const fixture = await seedP4bEligibleFixture(t);
  const { storage, opportunityId, now, decision } = fixture;
  const result = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: healthy });
  assert.equal(result.enrollment.state, 'campaign-created');
  return { ...fixture, campaign: result.campaign };
}

const ownerCommand = (storage, opportunityId, action) => recordAcquisitionOwnerCommand({
  storage, opportunityId, action, idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0,
  expectedMaterialRevision: 0, actor: 'fixture-owner' });

async function stop(storage, opportunityId, campaign) {
  const result = await stopPursueCimCampaign({ storage, opportunityId, campaignId: campaign.id,
    expectedRowVersion: campaign.row_version, expectedTerminalRevision: campaign.terminal_revision,
    idempotencyKey: randomUUID(), reason: 'Stopped by mistake.', actor: 'fixture-owner',
    getPauseStatus: async () => ({ paused: false }) });
  assert.equal(result.ok, true, result.error);
}

const campaignCount = (db) => db.prepare('SELECT COUNT(*) AS count FROM deal_hunter_cim_campaigns').get().count;

test('Request SIM while a campaign runs starts nothing and says so', async (t) => {
  const { storage, db, opportunityId } = await campaignFixture(t);
  const result = await ownerCommand(storage, opportunityId, 'pursue');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.notice?.code, 'campaign_running');
  assert.deepEqual(result.opportunity.campaign, { state: 'initial-pending', reasonCode: 'awaiting-window' });
  assert.equal(campaignCount(db), 1);
});

test('Request SIM after Stop starts nothing, says the campaign ended, and keeps the stopped state', async (t) => {
  const { storage, db, opportunityId, campaign } = await campaignFixture(t);
  await stop(storage, opportunityId, campaign);
  const result = await ownerCommand(storage, opportunityId, 'pursue');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.notice?.code, 'campaign_finished');
  assert.match(result.notice.message, /already ended/);
  assert.deepEqual(result.opportunity.campaign, { state: 'stopped', reasonCode: 'campaign_stopped' });
  assert.equal(campaignCount(db), 1);
});

test('Watch then Request SIM records the decision but names the finished campaign as the reason', async (t) => {
  const { storage, db, opportunityId, now } = await campaignFixture(t);
  const watch = await ownerCommand(storage, opportunityId, 'watch');
  assert.equal(watch.ok, true, watch.error);
  assert.equal(watch.notice, undefined);
  assert.deepEqual(watch.opportunity.campaign, { state: 'stopped', reasonCode: 'watch-selected' });
  // Enrollment against current, healthy sources: the earlier campaign is the only blocker.
  const decision = await storage.recordOwnerDecision({ opportunityId, action: 'pursue',
    idempotencyKey: 'pursue-after-watch', actor: 'fixture-owner', policyVersion: 'owner-decision-v1',
    now, expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 });
  const enrolled = await orchestratePursuitEnrollment({ storage, opportunityId,
    enrollment: decision.enrollment, decision: decision.decision, actor: 'fixture-owner',
    now, readSourceHealth: healthy });
  assert.equal(enrolled.enrollment.state, 'action-required');
  assert.equal(enrolled.enrollment.reason_code, 'prior_campaign_terminal');
  // Through the owner command the click is answered with the reason, and no campaign is added.
  const pursue = await ownerCommand(storage, opportunityId, 'pursue');
  assert.equal(pursue.ok, true, pursue.error);
  assert.equal(pursue.notice?.code, 'campaign_finished');
  assert.equal(campaignCount(db), 1);
});

test('queue rows and the detail view carry the latest campaign on SQLite', async (t) => {
  const { storage, opportunityId, campaign } = await campaignFixture(t);
  const listed = await storage.listDealHunterOpportunityScores({ view: 'all', pageSize: 100 });
  const row = listed.rows.find((item) => item.opportunity_id === opportunityId);
  assert.ok(row, 'the fixture listing is in the legacy queue');
  assert.deepEqual(publicTriageRow(row).campaign, { state: 'initial-pending', reasonCode: 'awaiting-window' });
  await stop(storage, opportunityId, campaign);
  const inbox = await storage.listDealHunterFreshInbox({ area: 'all-active', limit: 100 });
  const inboxRow = inbox.areas.flatMap((area) => area.rows)
    .find((item) => item.opportunity_id === opportunityId);
  assert.ok(inboxRow, 'the fixture listing is in the inbox');
  assert.deepEqual(publicTriageRow(inboxRow).campaign, { state: 'stopped', reasonCode: 'campaign_stopped' });
  assert.equal(inboxRow.cim_status, 'not-requested');
  const detail = await getTriageOpportunityDetail({ storage, opportunityId });
  assert.equal(detail.ok, true, detail.error);
  assert.deepEqual(detail.opportunity.campaign, { state: 'stopped', reasonCode: 'campaign_stopped' });
});

test('a listing with no campaign has a null campaign summary', () => {
  assert.equal(publicTriageRow({ opportunity_id: 'opp-none' }).campaign, null);
  assert.equal(publicCampaignSummary({ state: 'not-a-state' }), null);
});

test('a campaign past its day-28 window reads as expired before the sweep records it', () => {
  const now = new Date('2026-11-15T12:00:00.000Z');
  assert.deepEqual(publicCampaignSummary({ state: 'active-follow-up', reasonCode: 'awaiting-window',
    localExpiryAt: '2026-11-15T11:59:59.000Z' }, now),
  { state: 'expired', reasonCode: 'campaign_window_elapsed' });
  assert.deepEqual(publicCampaignSummary({ state: 'active-follow-up', reasonCode: 'awaiting-window',
    localExpiryAt: '2026-11-15T12:00:01.000Z' }, now),
  { state: 'active-follow-up', reasonCode: 'awaiting-window' });
  assert.deepEqual(publicCampaignSummary({ state: 'stopped', reasonCode: 'campaign_stopped',
    localExpiryAt: '2026-11-01T00:00:00.000Z' }, now),
  { state: 'stopped', reasonCode: 'campaign_stopped' });
});

test('a click that creates the campaign is not told one was already running', () => {
  const created = { state: 'initial-pending', reasonCode: 'awaiting-window' };
  // A waiting enrollment re-clicked: the writer changes nothing, enrollment then allocates.
  assert.equal(requestSimNotice({ result: { applied: false, replay: false }, campaign: created,
    priorCampaign: null }), null);
  assert.equal(requestSimNotice({ result: { applied: false, replay: false }, campaign: created,
    priorCampaign: created }).code, 'campaign_running');
  assert.equal(requestSimNotice({ result: { applied: false, replay: true }, campaign: created,
    priorCampaign: created }), null);
  assert.equal(requestSimNotice({ result: { applied: true, replay: false },
    campaign: { state: 'stopped', reasonCode: 'watch-selected' }, priorCampaign: null }).code, 'campaign_finished');
});
