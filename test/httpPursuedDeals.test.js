// Pursued deals tracker Task 5: GET /api/admin/deal-hunter/pursuing over real HTTP, on a real SQLite
// world (automatic Pursue picks a deal, its initial goes out, the broker replies), with only the
// Gmail mailbox faked. The world installs a fake process clock, so sessions are opened after it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-pursued-deals-'));
process.env.ADMIN_SESSION_SECRET = 'http-pursued-deals-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-pursued-deals-document-secret';
process.env.ADMIN_VIEWER_USERNAME = 'pursued-viewer';
process.env.ADMIN_VIEWER_PASSWORD = 'pursued-viewer-password';
process.env.SQLITE_PATH = path.join(tempDir, 'pursued-deals.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
process.env.DEAL_HUNTER_GMAIL_SENDER_ADDRESS = 'owner@uckele.test';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.DEAL_HUNTER_AUTO_PURSUE_ACTIVE_DAILY_CAP;
delete process.env.PUBLIC_SITE_URL;

const { createApp } = await import('../server/app.js');
const { getStorage } = await import('../server/storage/index.js');
const { getPursueCimReleaseReport } = await import('../server/services/pursueCimRelease.js');
const { pursuitStageRequestDigest } = await import('../server/storage/pursuitTrackerStorageContract.js');
const { HEALTHY_SOURCE_SNAPSHOT, START, autoPursuedAndSent, brokerReplies, createWorld, pacific, pollAt } =
  await import('./fixtures/pursueCimEndToEndFixture.js');

fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify(HEALTHY_SOURCE_SNAPSHOT));

const route = '/api/admin/deal-hunter/pursuing';
const OWNER = 'owner@uckele.test';
const WARMUP_DEALS = 25; // the fixture's auto-Pursue warm-up: archived opportunities with a pursue decision

const database = new Database(process.env.SQLITE_PATH);
test.after(() => {
  database.close();
  getStorage().close?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

let loginSequence = 0;
async function login(origin, username, password) {
  loginSequence += 1;
  const response = await fetch(`${origin}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${120 + loginSequence}` },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function get(origin, query, cookie) {
  const response = await fetch(`${origin}${route}${query}`, { headers: cookie ? { Cookie: cookie } : {} });
  const body = await response.text();
  return { status: response.status, body, json: JSON.parse(body) };
}

/** An active opportunity the owner chose Pursue on at `at`, with no campaign. */
async function seedPursuedDeal(storage, opportunityId, at) {
  await storage.upsertDealHunterOpportunity({ opportunity_id: opportunityId, created_at: at, updated_at: at,
    canonical_name: `Deal ${opportunityId}`, canonical_recipient: null, canonical_location: 'Fresno, CA',
    primary_submission_id: null, identity_version: 'pursuing-test', status: 'active', metadata: {} });
  database.prepare(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key, request_digest,
    opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
    observed_discovery_revision, observed_material_revision, policy_version, created_at)
    VALUES (?, ?, ?, ?, 'pursue', ?, 0, 0, 0, 0, 'owner-decision-v1', ?)`)
    .run(`decision-${opportunityId}`, `key-${opportunityId}`, 'd'.repeat(64), opportunityId, OWNER, at);
}

async function ownerMovesStage(storage, opportunityId, stage, at) {
  const base = { id: randomUUID(), idempotencyKey: randomUUID(), opportunityId, expectedPreviousEventId: 'genesis',
    kind: 'stage-move', replyType: null, fromStage: 'cim-requested', stage, acknowledgedReplyId: null,
    actor: OWNER, now: at };
  const result = await storage.recordPursuitStageEvent({ ...base, requestDigest: pursuitStageRequestDigest(base) });
  assert.equal(result.applied, true, JSON.stringify(result));
}

test('GET /api/admin/deal-hunter/pursuing', async (t) => {
  const createBackend = () => ({
    storage: getStorage(),
    all: async (sql, ...params) => database.prepare(sql).all(...params),
    run: async (sql, ...params) => { database.prepare(sql).run(...params); },
  });
  const world = await createWorld(t, createBackend, { start: START });
  const { storage } = world;
  const campaign = await autoPursuedAndSent(world);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => { warnings.push(args); });

  await withServer(async (origin) => {
    const adminCookie = await login(origin, 'admin', 'change-me-now');
    const viewerCookie = await login(origin, 'pursued-viewer', 'pursued-viewer-password');

    await t.test('anonymous read is 401', async () => {
      const response = await get(origin, '', null);
      assert.equal(response.status, 401);
      assert.deepEqual(response.json, { success: false, error: 'Authenticated admin access is required.' });
    });

    await t.test('rows carry the release campaign id, row version and terminal revision the stop route needs', async () => {
      const { json } = await get(origin, '', adminCookie);
      const row = json.rows.find((candidate) => candidate.opportunityId === 'opp-auto');
      const stored = await world.campaignFor('opp-auto');
      assert.deepEqual(row.release.campaign, { id: stored.id, state: 'active-follow-up',
        rowVersion: Number(stored.row_version), terminalRevision: Number(stored.terminal_revision) });
      assert.equal(row.release.canStop, true);
      const report = await getPursueCimReleaseReport({ storage, opportunityId: 'opp-auto', now: json.asOf });
      assert.deepEqual(row.release.status, report.status);
      assert.deepEqual([row.stage, row.stageLabel, row.stageSource, row.needsAction, row.crmSubmissionId,
        row.passedInDealHunter, row.opportunityActive, row.simDocuments, 'releaseUnavailable' in row],
      ['cim-requested', 'SIM requested', 'evidence', null, stored.crm_submission_id, false, true, [], false]);
      assert.equal(typeof stored.crm_submission_id, 'string');
      assert.equal(row.name, 'Acme Plumbing');
    });

    // The broker answers and the poller records it; two more deals sit at other stages.
    world.clock.set(pacific('2030-01-07', '14:00'));
    await brokerReplies(world, campaign, { body: 'Happy to share. Please sign the attached NDA.' });
    assert.equal((await pollAt(world, pacific('2030-01-07', '14:05'))).responded, 1);
    await seedPursuedDeal(storage, 'opp-nda', pacific('2030-01-07', '12:00'));
    await ownerMovesStage(storage, 'opp-nda', 'nda-sent', pacific('2030-01-07', '14:10'));
    await seedPursuedDeal(storage, 'opp-plain', pacific('2030-01-07', '13:00'));
    const { gmail_thread_id: threadId } = await world.conversation(campaign.conversation_id);
    const [replyRow] = await world.all(`SELECT gmail_message_id FROM deal_hunter_gmail_reply_messages
      WHERE conversation_id = ? AND classification = 'reply'`, campaign.conversation_id);

    await t.test('admin sees the reply row first with a Gmail link; a viewer gets neither the link nor the reply id', async () => {
      const admin = await get(origin, '', adminCookie);
      assert.equal(admin.status, 200);
      assert.equal(admin.json.success, true);
      const [first] = admin.json.rows;
      assert.equal(first.opportunityId, 'opp-auto');
      assert.deepEqual([first.stage, first.stageLabel, first.needsAction.reason, first.needsAction.replyId,
        first.needsAction.classification], ['broker-replied', 'Broker replied', 'reply', replyRow.gmail_message_id, 'reply']);
      // The active connection's mailbox wins over the configured sender.
      assert.equal(first.gmailThreadUrl,
        `https://mail.google.com/mail/?authuser=owner%40uckele.example.test#all/${threadId}`);
      assert.ok(Number.isFinite(Date.parse(first.lastReplyAt)));

      const viewer = await get(origin, '', viewerCookie);
      assert.equal(viewer.status, 200);
      assert.equal(viewer.json.rows[0].opportunityId, 'opp-auto');
      assert.equal(viewer.json.rows[0].needsAction.reason, 'reply');
      assert.equal(viewer.body.includes(first.needsAction.replyId), false);
      assert.equal(viewer.body.includes(threadId), false);
      assert.equal(viewer.body.includes('gmailThreadUrl'), false);
      assert.equal(viewer.json.rows.some((row) => 'gmailThreadUrl' in row || 'replyId' in (row.needsAction ?? {})), false);
    });

    await t.test('stage filter, needs-action filter and exact counts; unknown stage is 400 invalid_stage', async () => {
      const counts = { needsAction: 1, byStage: { 'cim-requested': WARMUP_DEALS + 1, 'broker-replied': 1,
        'nda-sent': 1, 'cim-received': 0, 'financial-review': 0, 'loi-candidate': 0, passed: 0 } };
      const all = await get(origin, '', adminCookie);
      assert.deepEqual(all.json.counts, counts);
      assert.equal(all.json.rows.length, WARMUP_DEALS + 3);
      assert.equal(all.json.truncated, false);
      // Needs-action first, then stage order, then newest stage change first.
      assert.deepEqual(all.json.rows.map((row) => row.opportunityId), ['opp-auto', 'opp-plain',
        ...Array.from({ length: WARMUP_DEALS }, (_, index) => `warmup-opp-${WARMUP_DEALS - 1 - index}`), 'opp-nda']);

      const ids = async (query) => (await get(origin, query, adminCookie)).json;
      const ndaOnly = await ids('?stage=nda-sent');
      assert.deepEqual(ndaOnly.rows.map((row) => row.opportunityId), ['opp-nda']);
      assert.equal(ndaOnly.rows[0].stageSource, 'owner');
      assert.deepEqual(ndaOnly.counts, counts);
      const attention = await ids('?stage=needs-action');
      assert.deepEqual(attention.rows.map((row) => row.opportunityId), ['opp-auto']);
      assert.deepEqual(attention.counts, counts);
      const requested = await ids('?stage=cim-requested');
      assert.equal(requested.rows.length, WARMUP_DEALS + 1);
      assert.equal(requested.rows.every((row) => row.stage === 'cim-requested'), true);
      assert.deepEqual((await ids('?stage=passed')).rows, []);
      assert.deepEqual((await ids('?stage=all')).counts, counts);

      const warmup = requested.rows.find((row) => row.opportunityId === 'warmup-opp-0');
      assert.deepEqual([warmup.opportunityActive, warmup.release.campaign, warmup.release.canStop],
        [false, null, false]);

      for (const bad of ['?stage=bogus', '?stage=', '?stage=cim-requested&stage=passed']) {
        const response = await get(origin, bad, adminCookie);
        assert.deepEqual([response.status, response.json.success, response.json.code], [400, false, 'invalid_stage']);
      }
    });

    await t.test('a row whose release report throws shows releaseUnavailable and the page still loads', async () => {
      const original = storage.readPursueCimProjection;
      storage.readPursueCimProjection = async (command) => {
        if (command.opportunityId === 'opp-nda') throw new Error('Pursue CIM release report campaign binding mismatch');
        return original.call(storage, command);
      };
      try {
        const { status, json } = await get(origin, '', adminCookie);
        assert.equal(status, 200);
        const nda = json.rows.find((row) => row.opportunityId === 'opp-nda');
        assert.deepEqual([nda.release, nda.releaseUnavailable, nda.stage], [null, true, 'nda-sent']);
        const auto = json.rows.find((row) => row.opportunityId === 'opp-auto');
        assert.equal(auto.release.campaign.id, campaign.id);
        assert.equal('releaseUnavailable' in auto, false);
      } finally {
        storage.readPursueCimProjection = original;
      }
      assert.equal(warnings.length >= 1, true);
      assert.deepEqual(warnings.at(-1)[1], { opportunityId: 'opp-nda', cause: 'Error' });
    });

    await t.test('with Gmail disconnected the link falls back to the configured sender', async () => {
      await storage.revokeGmailConnection({ revokedBy: OWNER, now: world.clock.peek().toISOString() });
      const [first] = (await get(origin, '', adminCookie)).json.rows;
      assert.equal(first.gmailThreadUrl, `https://mail.google.com/mail/?authuser=owner%40uckele.test#all/${threadId}`);
      const rowsWithoutThread = (await get(origin, '', adminCookie)).json.rows.filter((row) => row.opportunityId !== 'opp-auto');
      assert.equal(rowsWithoutThread.every((row) => row.gmailThreadUrl === null), true);
    });

    await t.test('more than 200 members returns 200 rows and truncated: true', async () => {
      const at = pacific('2030-01-07', '12:30');
      const insert = database.prepare(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key,
        request_digest, opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
        observed_discovery_revision, observed_material_revision, policy_version, created_at)
        VALUES (?, ?, ?, ?, 'pursue', ?, 0, 0, 0, 0, 'owner-decision-v1', ?)`);
      const upsert = database.prepare(`INSERT INTO deal_hunter_opportunities (opportunity_id, created_at,
        updated_at, canonical_name, canonical_recipient, canonical_location, primary_submission_id,
        identity_version, status, metadata) VALUES (?, ?, ?, ?, NULL, 'Fresno, CA', NULL, 'pursuing-test', 'active', '{}')`);
      database.transaction(() => {
        for (let index = 0; index < 201; index += 1) {
          const id = `bulk-opp-${index}`;
          upsert.run(id, at, at, `Bulk ${index}`);
          insert.run(`decision-${id}`, `key-${id}`, 'd'.repeat(64), id, OWNER, at);
        }
      })();
      const { json } = await get(origin, '', adminCookie);
      assert.equal(json.rows.length, 200);
      assert.equal(json.truncated, true);
      assert.equal(json.rows[0].opportunityId, 'opp-auto');
      const members = WARMUP_DEALS + 3 + 201;
      assert.equal(Object.values(json.counts.byStage).reduce((sum, n) => sum + n, 0), members);
      assert.equal(json.counts.byStage['cim-requested'], WARMUP_DEALS + 1 + 201);
      assert.equal(json.counts.needsAction, 1);
      const requested = await get(origin, '?stage=cim-requested', adminCookie);
      assert.deepEqual([requested.json.rows.length, requested.json.truncated], [200, true]);
    });
  });
});
