// Ruling K: turning Live sending on records the production-gmail-v1 capability chain the
// sender needs; turning it off withdraws it. Every change goes through the audited activation
// transitions. Real SQLite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  PURSUE_GMAIL_CAPABILITY_CHAIN,
  syncPursueGmailCapabilities,
} from '../server/services/pursueGmailCapabilities.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const NOW = '2030-10-28T15:00:00.000Z';
const LATER = '2030-10-29T15:00:00.000Z';

function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-gmail-capabilities-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, 'storage.sqlite');
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  return { storage, database };
}

const current = (database) => database.prepare(`SELECT * FROM
  deal_hunter_cim_capability_activations WHERE status = 'current' ORDER BY capability`).all();

test('Live sending on records the production-gmail-v1 chain, audited, and replays as a no-op', async (t) => {
  const { storage, database } = store(t);
  assert.deepEqual(PURSUE_GMAIL_CAPABILITY_CHAIN,
    ['fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup']);
  const on = await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner@example.test',
    now: NOW });
  assert.equal(on.applied, true);
  const rows = current(database);
  assert.deepEqual(rows.map((row) => row.capability),
    ['fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup']);
  const byCapability = Object.fromEntries(rows.map((row) => [row.capability, row]));
  for (const row of rows) {
    assert.equal(row.provider_profile, 'production-gmail-v1');
    assert.equal(row.mode, 'active');
    assert.equal(row.actor, 'owner@example.test');
    assert.equal(row.expires_at, null);
    // The rule, not a per-recipient grant, is the enrollment permission (Ruling K/H).
    assert.equal(row.permission_basis_digest, null);
    assert.equal(row.cohort_digest, null);
  }
  assert.equal(byCapability['fl04b-enrollment'].prerequisite_activation_id, byCapability['fl04a-safety'].id);
  assert.equal(byCapability['fl04b-initial'].prerequisite_activation_id, byCapability['fl04b-enrollment'].id);
  assert.equal(byCapability['fl04c-followup'].prerequisite_activation_id, byCapability['fl04b-initial'].id);
  assert.ok(byCapability['fl04c-followup'].daily_cap > 0);
  assert.ok(byCapability['fl04c-followup'].recipient_cap > 0);
  assert.deepEqual(Object.keys(on.activations).sort(), [...PURSUE_GMAIL_CAPABILITY_CHAIN].sort());
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM deal_hunter_cim_audit_events
    WHERE event_type = 'capability-activation'`).get().n, 4);
  // On again while the chain is intact changes nothing.
  const again = await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner@example.test',
    now: LATER });
  assert.equal(again.applied, false);
  assert.deepEqual(current(database).map((row) => row.id), rows.map((row) => row.id));
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM deal_hunter_cim_audit_events
    WHERE event_type = 'capability-activation'`).get().n, 4);
});

test('Live sending off withdraws the chain and nothing is listed; on again records a new chain', async (t) => {
  const { storage, database } = store(t);
  await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner', now: NOW });
  const first = current(database).map((row) => row.id);
  const off = await syncPursueGmailCapabilities({ storage, enabled: false, actor: 'owner', now: LATER });
  assert.equal(off.applied, true);
  assert.deepEqual(off.withdrawn.sort(), [...first].sort());
  assert.deepEqual(current(database), []);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM deal_hunter_cim_audit_events
    WHERE event_type = 'capability-withdrawn'`).get().n, 4);
  assert.deepEqual(await storage.listDueCimInitialTouches({ now: LATER }), []);
  assert.deepEqual(await storage.listDueCimFollowUpTouches({ now: LATER }), []);
  const offAgain = await syncPursueGmailCapabilities({ storage, enabled: false, actor: 'owner',
    now: LATER });
  assert.equal(offAgain.applied, false);
  await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner',
    now: '2030-10-30T15:00:00.000Z' });
  const second = current(database).map((row) => row.id);
  assert.equal(second.length, 4);
  assert.equal(second.some((id) => first.includes(id)), false);
});

test('Live sending on replaces another profile chain and repairs a broken one', async (t) => {
  const { storage, database } = store(t);
  const base = { mode: 'active', policyHash: 'a'.repeat(64), configHash: 'b'.repeat(64),
    actor: 'harness', reason: 'controlled test', confirmation: 'harness', now: NOW,
    providerProfile: 'controlled-mailbox-v1' };
  await storage.recordCimCapabilityActivation({ ...base, id: 'harness-safety',
    capability: 'fl04a-safety' });
  await storage.recordCimCapabilityActivation({ ...base, id: 'harness-enrollment',
    capability: 'fl04b-enrollment', prerequisiteActivationId: 'harness-safety',
    prerequisiteEvidenceId: 'evidence', prerequisiteEvidenceHash: 'c'.repeat(64) });
  await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner', now: LATER });
  assert.deepEqual(current(database).map((row) => row.provider_profile),
    Array(4).fill('production-gmail-v1'));
  // Off withdraws only the production-gmail-v1 chain.
  await syncPursueGmailCapabilities({ storage, enabled: false, actor: 'owner', now: LATER });
  assert.equal(database.prepare(`SELECT status FROM deal_hunter_cim_capability_activations
    WHERE id = 'harness-safety'`).get().status, 'superseded');
  // A withdrawn link is repaired from that link down.
  await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner',
    now: '2030-10-30T15:00:00.000Z' });
  const chain = current(database);
  const initial = chain.find((row) => row.capability === 'fl04b-initial');
  await storage.withdrawCimCapabilityActivation({ id: initial.id, actor: 'owner', reason: 'test',
    now: '2030-10-30T16:00:00.000Z' });
  const repaired = await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner',
    now: '2030-10-30T17:00:00.000Z' });
  assert.equal(repaired.applied, true);
  const after = Object.fromEntries(current(database).map((row) => [row.capability, row.id]));
  const before = Object.fromEntries(chain.map((row) => [row.capability, row.id]));
  assert.equal(after['fl04a-safety'], before['fl04a-safety']);
  assert.equal(after['fl04b-enrollment'], before['fl04b-enrollment']);
  assert.notEqual(after['fl04b-initial'], before['fl04b-initial']);
  assert.notEqual(after['fl04c-followup'], before['fl04c-followup']);
});

test('the helper validates its input', async (t) => {
  const { storage } = store(t);
  await assert.rejects(syncPursueGmailCapabilities({ storage, enabled: 'yes', actor: 'owner', now: NOW }),
    /enabled/);
  await assert.rejects(syncPursueGmailCapabilities({ storage, enabled: true, actor: '', now: NOW }),
    /actor/);
  await assert.rejects(syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner',
    now: 'not-a-time' }), /instant/);
});
