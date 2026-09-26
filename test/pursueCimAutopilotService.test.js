import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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

test('P0 scenarios 2 and 12: August no-URL listing retains its fingerprint when the URL arrives', async (t) => {
  const storage = createIdentityStorage(t);
  const original = await resolveDealHunterOpportunity({
    deal: augustNoUrlListing,
    storage,
    actor: 'pursue-cim-regression',
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
  assert.equal(later.ok, true);
  assert.equal(later.opportunityId, original.opportunityId);
  assert.ok(aliases.some(({ alias_type }) => alias_type === 'fingerprint-v1'));
  assert.ok(aliases.some(({ alias_type }) => alias_type === 'listing-url'));
  assert.equal((await storage.listCurrentDealHunterOpportunities({ limit: 100 })).length, 1);
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
