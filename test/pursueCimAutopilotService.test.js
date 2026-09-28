import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCimCurrentAuthority, runCimCampaignSafety } from '../server/services/cimCampaignSafety.js';
import { resolveDealHunterOpportunity } from '../server/services/cimOpportunityIdentity.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  augustLaterUrlListing,
  augustMateriallyDistinctLookalike,
  augustNoUrlListing,
} from './fixtures/pursueCimIncidentFixtures.js';

function createIdentityStorage(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-pursue-cim-identity-'));
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(directory, 'identity.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return storage;
}

test('P2 safety shadow accounts for a run without consuming or mutating it', async () => {
  let consumptions = 0;
  const storage = {
    async listCimSafetyEvents() { return [{ id: 'event-1', status: 'pending',
      opportunity_id: 'op-shadow', event_type: 'source-record-changed' }]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending' } }; },
    async listDealHunterSourceFreshnessStates() { return []; },
    async consumeCimSafetyEvents() { consumptions += 1; throw new Error('shadow mutated safety'); },
  };
  const result = await runCimCampaignSafety({ storage, safetyRunId: 'safety-shadow',
    mode: 'shadow', now: '2026-09-28T12:00:00.000Z' });
  assert.equal(consumptions, 0);
  assert.deepEqual(result, { safetyRunId: 'safety-shadow', safetyEventsEmitted: 1,
    stopped: 0, reviewRequired: 0, noOp: 0, pending: 1,
    sourceProjectionPending: false, complete: false,
    proposed: { stopped: 0, reviewRequired: 1, noOp: 0 } });
});

test('P2 current authority exposes deferred source and open identity exception before safety consumption', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active', material_revision: 2 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'sheet-0',
      source_record_id: 'external:LAG', field: 'name', value: 'Lag Fixture' }]; },
    async listDealHunterIdentityExceptions() { return [{ id: 'exception-lag', status: 'open',
      candidate_opportunity_ids: ['op-lag'] }]; },
    async listDealHunterSourceFreshnessStates() { return [{ source_id: 'sheet-0',
      accepted_run_id: 'run-lag', projection_state: 'deferred' }]; },
    async readPursueCimProjection() { return { campaign: null }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.opportunity.material_revision, 2);
  assert.deepEqual(authority.blockers, ['identity-exception-open', 'source-projection-deferred']);
  assert.equal(authority.blocked, true);
});

test('P2 pending safety consumption cannot hide a changed campaign material revision', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active',
      material_revision: 2, discovery_revision: 1 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'sheet-0',
      source_record_id: 'external:LAG', field: 'asking_price', value: '120' }]; },
    async listDealHunterIdentityExceptions() { return []; },
    async listDealHunterSourceFreshnessStates() { return [{ source_id: 'sheet-0',
      accepted_run_id: 'changed-run', projection_state: 'accepted' }]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending',
      material_revision: 1, discovery_revision: 1 } }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.blocked, true);
  assert.deepEqual(authority.blockers, ['campaign-material-authority-changed',
    'campaign-source-authority-unproven']);
});

test('P2 consumer lag blocks a newly accepted source run when campaign revisions stay unchanged', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active',
      material_revision: 1, discovery_revision: 1 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'sheet-0',
      source_record_id: 'external:LAG', field: 'name', value: 'Changed broker name',
      accepted_at: '2026-09-28T12:01:00.000Z' }]; },
    async listDealHunterIdentityExceptions() { return []; },
    async listDealHunterSourceFreshnessStates() { return [{ source_id: 'sheet-0',
      accepted_run_id: 'run-after-campaign', accepted_at: '2026-09-28T12:01:00.000Z',
      projection_state: 'accepted' }]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending',
      created_at: '2026-09-28T12:00:00.000Z', material_revision: 1, discovery_revision: 1 } }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.blocked, true);
  assert.ok(authority.blockers.includes('campaign-source-authority-changed'));
});

test('P2 current authority sees a required Sheet removal even when only Deal OS rows remain', async () => {
  const storage = {
    async getCurrentDealHunterOpportunity() { return { opportunity_id: 'op-lag', status: 'active',
      material_revision: 1, discovery_revision: 1 }; },
    async listDealHunterOpportunitySourceObservations() { return [{ source_id: 'deal-os-export',
      source_record_id: 'external:OLD', field: 'name', value: 'Prior name',
      accepted_at: '2026-09-28T11:59:00.000Z' }]; },
    async listDealHunterIdentityExceptions() { return []; },
    async listDealHunterSourceFreshnessStates() { return [
      { source_id: 'sheet-0', accepted_run_id: 'sheet-removal',
        accepted_at: '2026-09-28T12:01:00.000Z', projection_state: 'accepted' },
      { source_id: 'deal-os-export', accepted_run_id: 'old-os',
        accepted_at: '2026-09-28T11:59:00.000Z', projection_state: 'accepted' },
    ]; },
    async readPursueCimProjection() { return { campaign: { state: 'initial-pending',
      created_at: '2026-09-28T12:00:00.000Z', material_revision: 1, discovery_revision: 1 } }; },
  };
  const authority = await readCimCurrentAuthority({ storage, opportunityId: 'op-lag',
    readSourceHealth: async () => ({ healthy: true, issues: [] }) });
  assert.equal(authority.blocked, true);
  assert.ok(authority.blockers.includes('campaign-source-authority-changed'));
});

test('P0 scenarios 2 and 12: August no-URL listing retains its fingerprint when the URL arrives', async (t) => {
  const storage = createIdentityStorage(t);
  const original = await resolveDealHunterOpportunity({
    deal: augustNoUrlListing,
    storage,
    actor: 'pursue-cim-regression',
  });
  const repeat = await resolveDealHunterOpportunity({
    deal: augustNoUrlListing, storage, actor: 'pursue-cim-regression',
  });
  const later = await resolveDealHunterOpportunity({
    deal: augustLaterUrlListing,
    storage,
    actor: 'pursue-cim-regression',
  });
  const aliases = await storage.listDealHunterOpportunityAliases({
    opportunityIds: [original.opportunityId],
    limit: 100,
  });

  assert.equal(original.ok, true);
  assert.equal(repeat.opportunityId, original.opportunityId);
  assert.equal(later.ok, true);
  assert.equal(later.opportunityId, original.opportunityId);
  assert.ok(aliases.some(({ alias_type }) => alias_type === 'fingerprint-v1'));
  assert.ok(aliases.some(({ alias_type }) => alias_type === 'listing-url'));
  assert.equal((await storage.listCurrentDealHunterOpportunities({ limit: 100 })).length, 1);
  assert.equal((await storage.readCimOutreachCounters()).campaigns, 0);
});

test('P0 scenario 5: exact syndicated listing identity resolves through its canonical aliases', async (t) => {
  const storage = createIdentityStorage(t);
  const sheet = await resolveDealHunterOpportunity({ deal: augustLaterUrlListing,
    storage, actor: 'pursue-cim-regression' });
  const syndicated = await resolveDealHunterOpportunity({ deal: {
    ...augustLaterUrlListing, sourceId: 'deal-os-export', id: 'syndicated-august',
    dealKey: 'deal-os:syndicated-august', sourceRecords: [{ sourceId: 'deal-os-export' }],
  }, storage, actor: 'pursue-cim-regression' });
  assert.equal(sheet.ok, true);
  assert.equal(syndicated.ok, true);
  assert.equal(syndicated.opportunityId, sheet.opportunityId);
  assert.equal((await storage.listCurrentDealHunterOpportunities({ limit: 100 })).length, 1);
  assert.equal((await storage.readCimOutreachCounters()).campaigns, 0);
});

test('P0 scenario 3: independent SQLite connections converge simultaneous Sheet and Deal OS identity', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-p2-concurrent-identity-'));
  const sqlitePath = path.join(directory, 'identity.sqlite');
  const sheetStorage = createSqliteStorage({ storage: { sqlitePath } });
  const dealOsStorage = createSqliteStorage({ storage: { sqlitePath } });
  t.after(() => { sheetStorage.close(); dealOsStorage.close();
    fs.rmSync(directory, { recursive: true, force: true }); });
  const [sheet, dealOs] = await Promise.all([
    resolveDealHunterOpportunity({ deal: augustLaterUrlListing,
      storage: sheetStorage, actor: 'pursue-cim-regression' }),
    resolveDealHunterOpportunity({ deal: { ...augustLaterUrlListing,
      sourceId: 'deal-os-export', id: 'concurrent-august',
      dealKey: 'deal-os:concurrent-august', sourceRecords: [{ sourceId: 'deal-os-export' }] },
    storage: dealOsStorage, actor: 'pursue-cim-regression' }),
  ]);
  const opportunities = await sheetStorage.listCurrentDealHunterOpportunities({ limit: 100 });
  const exceptions = await sheetStorage.listDealHunterIdentityExceptions({ statuses: ['open'] });
  assert.ok((sheet.ok && dealOs.ok && sheet.opportunityId === dealOs.opportunityId)
    || exceptions.length === 1);
  assert.ok(opportunities.length <= 2);
  assert.equal((await sheetStorage.readCimOutreachCounters()).campaigns, 0);
});
test('P0 scenario 4: materially distinct August lookalike remains a separate canonical opportunity', async (t) => {
  const storage = createIdentityStorage(t);
  const original = await resolveDealHunterOpportunity({
    deal: augustNoUrlListing,
    storage,
    actor: 'pursue-cim-regression',
  });
  const lookalike = await resolveDealHunterOpportunity({
    deal: augustMateriallyDistinctLookalike,
    storage,
    actor: 'pursue-cim-regression',
  });

  assert.equal(original.ok, true);
  assert.equal(lookalike.ok, true);
  assert.notEqual(lookalike.opportunityId, original.opportunityId);
  assert.equal((await storage.listCurrentDealHunterOpportunities({ limit: 100 })).length, 2);
});
