// A real-SQLite Pursue sender world under a controlled clock: rule-based campaigns with a
// scheduled initial touch, every send control on, the production-gmail-v1 capability chain
// recorded by the Live sending helper, and the fake Gmail mailbox. Only the mailbox is fake.
//
// The controlled clock runs ahead of the wall clock (2030), because the follow-up capacity
// trigger compares claim and reservation expiry with SQLite's own clock; everything else reads
// the controlled clock, including follow-up preparation through `pursueCimExecutionClock`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createFakeCimProvider } from '../../server/services/fakeCimProvider.js';
import { CONTACT_POLICY_VERSION, contactPolicyDigest } from '../../server/services/pursueCimContactPolicy.js';
import { syncPursueGmailCapabilities } from '../../server/services/pursueGmailCapabilities.js';
import { runPursueCimSender } from '../../server/services/pursueCimSender.js';
import { createSqliteStorage } from '../../server/storage/sqlite.js';
import {
  SENDER,
  enableSendControls,
  fixtureMemberAuthority,
  fixtureRecipientFingerprint,
  gmailConfig,
  seedCampaign,
} from './pursueCimGmailGateFixture.js';

export const MINUTE = 60_000;

/** A clock that returns a new instant on every call (one second apart), like a real clock. */
export function controlledClock(startIso, stepMs = 1000) {
  let current = Date.parse(startIso);
  const clock = () => {
    const at = new Date(current);
    current += stepMs;
    return at;
  };
  clock.set = (iso) => { current = Date.parse(iso); };
  clock.peek = () => new Date(current);
  clock.advance = (ms) => { current += ms; };
  return clock;
}

function temporaryPath(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ug-${prefix}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'storage.sqlite');
}

/**
 * @param {object} options
 * @param {string} options.start  the clock's first instant
 * @param {Array<{suffix: string, dueAt: string, dueLocal: string}>} options.campaigns
 */
export async function createSenderFixture(t, { start, campaigns }) {
  const clock = controlledClock(start);
  const sqlitePath = temporaryPath(t, 'pursue-sender');
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: 0 } },
  { pursueCimExecutionClock: () => clock.peek().toISOString() });
  t.after(() => storage.close());
  const database = new Database(sqlitePath);
  t.after(() => database.close());
  const seeded = {};
  for (const { suffix, dueAt, dueLocal } of campaigns) {
    const ids = seedCampaign(database, suffix,
      fixtureRecipientFingerprint(`opp-gmail-${suffix}`), { followUp: false, now: start });
    database.prepare(`UPDATE deal_hunter_cim_campaigns SET permission_version = ?,
      permission_digest = ?, permission_revision = 1 WHERE id = ?`)
      .run(CONTACT_POLICY_VERSION, contactPolicyDigest(), ids.campaignId);
    database.prepare(`UPDATE deal_hunter_cim_campaign_touches SET due_at = ?, due_local = ?
      WHERE id = ?`).run(dueAt, dueLocal, ids.touchId);
    seeded[suffix] = ids;
  }
  database.prepare(`INSERT INTO deal_hunter_cim_safety_settings (id, updated_at, outreach_paused,
    updated_by, metadata) VALUES ('global', ?, 0, 'fixture-owner', '{}')`).run(start);
  await enableSendControls(storage, { now: start });
  const capabilities = await syncPursueGmailCapabilities({ storage, enabled: true,
    actor: 'fixture-owner', now: start });
  const mailProvider = createFakeCimProvider({ now: () => clock.peek(), senderAddress: SENDER });
  const config = gmailConfig();
  const loadMemberAuthority = async ({ opportunityId }) => fixtureMemberAuthority(opportunityId);
  const submissionOf = (opportunityId) => Object.values(seeded)
    .find((ids) => ids.opportunityId === opportunityId)?.submissionId;
  const loadInitialAuthority = async ({ opportunityId }) => ({
    ...fixtureMemberAuthority(opportunityId), sourceRows: [], score: null,
    opportunity: { canonical_name: 'Acme Plumbing' },
    submission: { id: submissionOf(opportunityId) },
  });
  const readCurrentAuthority = async ({ opportunityId }) => ({ opportunityId, blocked: false,
    blockers: [],
    opportunity: database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?')
      .get(opportunityId),
    sourceRows: database.prepare(`SELECT * FROM deal_hunter_opportunity_source_observations
      WHERE opportunity_id = ? ORDER BY id`).all(opportunityId),
    sourceStates: database.prepare(`SELECT * FROM deal_hunter_source_freshness_state
      ORDER BY source_id`).all(),
    sourceHealth: { healthy: true, issues: [], requiredSources: ['sheet-0'] },
    identityExceptions: [] });
  const run = (overrides = {}) => runPursueCimSender({ storage, mailProvider, clock, config,
    loadMemberAuthority, loadInitialAuthority, readCurrentAuthority, ...overrides });
  const row = (table, id) => database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  const touches = (campaignId) => database.prepare(`SELECT * FROM deal_hunter_cim_campaign_touches
    WHERE campaign_id = ? ORDER BY ordinal, id`).all(campaignId);
  const count = (table, where = '1 = 1', ...values) => database.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...values).n;
  return { storage, database, clock, mailProvider, config, campaigns: seeded, capabilities,
    loadMemberAuthority, loadInitialAuthority, readCurrentAuthority, run, row, touches, count };
}
