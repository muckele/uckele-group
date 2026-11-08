import assert from 'node:assert/strict';
import test from 'node:test';

import { getPursueCimReleaseReport } from '../server/services/pursueCimRelease.js';

function storageForCampaign(campaign, transmission = null) {
  return {
    async readPursueCimProjection() {
      return { decision: { action: 'pursue' }, enrollment: { state: 'campaign-created' },
        campaign, initialTouch: null, transmission,
        legacySummary: { count: 0, accepted: 0, ambiguous: 0 } };
    },
    async getCurrentDealHunterOpportunity() {
      return { opportunity_id: campaign.opportunity_id, canonical_name: 'Expiry fixture',
        status: 'active' };
    },
    async readPursuitEnrollmentAuthority() {
      return { timezone: null, activation: null, globalAuthorityRevision: 1 };
    },
    async getPursueCimBrokerConversation() {
      return { id: campaign.conversation_id,
        recipient_authority_id: campaign.recipient_authority_id,
        recipient_fingerprint: campaign.recipient_fingerprint,
        recipient_address: 'broker@example.test' };
    },
    async getCrmCommunication() { return null; },
    async readCimCadenceContext() {
      return { transmission, members: [{ membership: { transmission_id: transmission.id,
        campaign_id: campaign.id, touch_id: 'touch-precedence', opportunity_id: campaign.opportunity_id,
        display_ordinal: 0, cancelled_at: null } }] };
    },
  };
}

test('release report projects elapsed bounded campaigns as expired without mutating storage', async () => {
  const campaign = { id: 'campaign-expiry', opportunity_id: 'opportunity-expiry',
    conversation_id: 'conversation-expiry', state: 'active-follow-up', reason_code: null,
    local_expiry_at: '2026-10-23T19:00:07.000Z', row_version: 8, terminal_revision: 0,
    generation: 1, policy_version: 'deal-hunter-cim-autopilot-v1',
    recipient_authority_id: 'recipient-expiry', recipient_fingerprint: 'a'.repeat(64) };
  const storage = storageForCampaign(campaign);
  const before = await getPursueCimReleaseReport({ storage, opportunityId: campaign.opportunity_id,
    now: '2026-10-23T19:00:06.999Z', getPauseStatus: async () => ({ paused: true }) });
  assert.equal(before.status.code, 'active_follow_up');
  const expired = await getPursueCimReleaseReport({ storage,
    opportunityId: campaign.opportunity_id, now: '2026-10-23T19:00:07.000Z',
    getPauseStatus: async () => ({ paused: true }) });
  assert.deepEqual(expired.status,
    { code: 'expired', reason: 'campaign_window_elapsed', actionRequired: false });
  assert.equal(expired.campaign.state, 'active-follow-up', 'projection does not invent a durable state');
  assert.equal(expired.actions.canStop, false, 'elapsed campaign cannot present a stale stop action');
});

test('release expiry projection never overrides provider ambiguity or durable terminal state', async () => {
  const campaign = { id: 'campaign-precedence', opportunity_id: 'opportunity-precedence',
    conversation_id: 'conversation-precedence', state: 'stopped', reason_code: 'owner_stop',
    local_expiry_at: '2026-10-01T00:00:00.000Z', row_version: 9, terminal_revision: 1,
    generation: 1, policy_version: 'deal-hunter-cim-autopilot-v1',
    recipient_authority_id: 'recipient-precedence', recipient_fingerprint: 'b'.repeat(64) };
  const report = await getPursueCimReleaseReport({ storage: storageForCampaign(campaign),
    opportunityId: campaign.opportunity_id, now: '2026-10-23T19:00:07.000Z',
    getPauseStatus: async () => ({ paused: true }) });
  assert.equal(report.status.code, 'campaign_stopped');
  campaign.state = 'active-follow-up';
  const transmission = { id: 'transmission-precedence', state: 'ambiguous',
    release_state: 'reconciliation-only', communication_id: 'communication-precedence',
    row_version: 3, preparation_generation: 1, to_addresses: ['broker@example.test'],
    cc_addresses: [], bcc_addresses: [], created_at: '2026-09-30T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z' };
  const ambiguous = await getPursueCimReleaseReport({
    storage: storageForCampaign(campaign, transmission), opportunityId: campaign.opportunity_id,
    now: '2026-10-23T19:00:07.000Z', getPauseStatus: async () => ({ paused: true }) });
  assert.equal(ambiguous.status.code, 'provider_ambiguous');
});

async function reportPauseWith(getDealHunterCimSafetySettings) {
  const campaign = { id: 'campaign-pause', opportunity_id: 'opportunity-pause',
    conversation_id: 'conversation-pause', state: 'initial-pending', reason_code: null,
    local_expiry_at: null, row_version: 1, terminal_revision: 0, generation: 1,
    policy_version: 'deal-hunter-cim-autopilot-v1', recipient_authority_id: 'recipient-pause',
    recipient_fingerprint: 'a'.repeat(64) };
  const report = await getPursueCimReleaseReport({
    storage: { ...storageForCampaign(campaign), getDealHunterCimSafetySettings },
    opportunityId: campaign.opportunity_id, now: '2026-10-23T19:00:00.000Z' });
  return report.pause;
}

test('release pause reports what the Gmail sender obeys: the saved control, not the fly.toml setting', async () => {
  const previous = process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED;
  process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED = 'true';
  try {
    assert.deepEqual(await reportPauseWith(async () => ({ outreach_paused: 0, updated_at: '2026-10-23T18:00:00.000Z' })),
      { paused: false, source: '', updatedAt: '2026-10-23T18:00:00.000Z' });
  } finally {
    if (previous === undefined) delete process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED;
    else process.env.DEAL_HUNTER_CIM_OUTREACH_PAUSED = previous;
  }
});

test('release pause shows a saved pause as paused from the Operations control', async () => {
  assert.deepEqual(await reportPauseWith(async () => ({ outreach_paused: 1, updated_at: '2026-10-23T18:00:00.000Z' })),
    { paused: true, source: 'operations-control', updatedAt: '2026-10-23T18:00:00.000Z' });
});

test('release pause fails closed when the saved control is missing or unreadable, as the sender does', async () => {
  assert.equal((await reportPauseWith(async () => null)).paused, true);
  assert.equal((await reportPauseWith(async () => { throw new Error('storage down'); })).paused, true);
});
