// Pursued deals tracker Task 5: GET /api/admin/deal-hunter/pursuing over real HTTP, on a real SQLite
// world (automatic Pursue picks a deal, its initial goes out, the broker replies), with only the
// Gmail mailbox faked. The world installs a fake process clock, so sessions are opened after it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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
const { getConfig } = await import('../server/config.js');
const { createBackupBundle, verifyBackupBundle } = await import('../server/services/backups.js');
const { HEALTHY_SOURCE_SNAPSHOT, START, autoPursuedAndSent, brokerReplies, createWorld, ownerRequestsSim, pacific,
  pollAt, seedDeal } = await import('./fixtures/pursueCimEndToEndFixture.js');

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

// `bodyBytesRead` counts, per `X-Test-Tag` request header, the body bytes the server's request
// stream delivered to a reader ('data' events), without changing how the request is read.
async function withServer(run, appOptions = {}) {
  const server = createApp(appOptions).listen(0, '127.0.0.1');
  const bodyBytesRead = new Map();
  server.prependListener('request', (request) => {
    const tag = request.headers['x-test-tag'];
    if (!tag) return;
    bodyBytesRead.set(tag, 0);
    const emit = request.emit;
    request.emit = function countData(event, ...args) {
      if (event === 'data') bodyBytesRead.set(tag, bodyBytesRead.get(tag) + args[0].length);
      return emit.call(this, event, ...args);
    };
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    await run(`http://127.0.0.1:${server.address().port}`, { bodyBytesRead });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const SIM_MAX_BYTES = 25 * 1024 * 1024;
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(150_000, 0x41), Buffer.from('\n%%EOF\n')]);
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/**
 * A raw SIM upload over its own socket. The request line and headers go out at once; the body is
 * written only if given, and the request is left open when `hold` is set. `response` settles with
 * the server's answer, or with `{ error }` when the server closed the socket instead.
 */
function openUpload(origin, opportunityId, { cookie, headers = {}, body = null, hold = false, tag = randomUUID() }) {
  const { hostname, port } = new URL(origin);
  const request = http.request({ hostname, port, method: 'POST', path: `${route}/${opportunityId}/sim`,
    headers: { 'X-Test-Tag': tag, ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const response = new Promise((resolve) => {
    request.on('response', (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: incoming.statusCode, headers: incoming.headers, body: text,
          json: text ? JSON.parse(text) : null });
      });
      incoming.on('error', (error) => resolve({ error }));
    });
    request.on('error', (error) => resolve({ error }));
  });
  if (body) request.write(body);
  if (hold) request.flushHeaders();
  else request.end();
  return { request, response, tag };
}

const simHeaders = ({ key = randomUUID(), name = 'Acme-SIM.pdf', length, type = 'application/pdf' } = {}) => ({
  'Content-Type': type, 'Content-Length': String(length), 'X-Idempotency-Key': key, 'X-File-Name': name });

async function waitFor(predicate, what) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Every file under the vault that no secure_documents row names, and every empty upload directory. */
function vaultLitter() {
  const root = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
  if (!fs.existsSync(root)) return [];
  const stored = new Set(database.prepare('SELECT storage_path FROM secure_documents').all()
    .map((row) => row.storage_path));
  const litter = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.trash') continue;
    const directory = path.join(root, entry.name);
    const files = fs.readdirSync(directory);
    if (files.length === 0) litter.push(directory);
    for (const file of files) {
      if (!stored.has(path.join(directory, file))) litter.push(path.join(directory, file));
    }
  }
  return litter;
}

const unsettledCleanupJobs = () => database.prepare(
  "SELECT id, status FROM secure_document_cleanup_jobs WHERE status <> 'completed'").all();

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

async function post(origin, opportunityId, action, body, cookie) {
  const response = await fetch(`${origin}${route}/${opportunityId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text, json: JSON.parse(text) };
}

/** `storage` with some methods replaced; every other method stays bound to the real storage. */
function storageWith(storage, overrides) {
  return new Proxy(storage, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const eventCount = (opportunityId) => database.prepare(
  'SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events WHERE opportunity_id = ?').get(opportunityId).n;

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

  await withServer(async (origin, { bodyBytesRead }) => {
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

    // ---- Task 6: the owner's writes (reply type, stage move, acknowledge) ----
    let minute = 0;
    const tick = () => { minute += 1; world.clock.set(pacific('2030-01-07', `15:${String(minute).padStart(2, '0')}`)); };
    // The list is capped at 200 rows, so only the needs-action deal is read from it; the others by chain tip.
    const rowOf = async (opportunityId) => (await get(origin, '', adminCookie)).json.rows
      .find((row) => row.opportunityId === opportunityId);
    const tipOf = (opportunityId) => database.prepare(`SELECT e.id FROM deal_hunter_pursuit_stage_events e
      WHERE e.opportunity_id = ? AND NOT EXISTS (SELECT 1 FROM deal_hunter_pursuit_stage_events n
        WHERE n.previous_event_id = e.id)`).get(opportunityId)?.id ?? 'genesis';

    await t.test('one reply-type click moves the stage, clears attention, and Undo moves it back', async () => {
      tick();
      const before = await rowOf('opp-auto');
      assert.equal(before.needsAction.reason, 'reply');
      assert.equal(before.latestEventId, 'genesis');
      const recorded = await post(origin, 'opp-auto', 'reply-type', { replyType: 'nda-requested',
        idempotencyKey: randomUUID(), expectedLatestEventId: 'genesis',
        acknowledgedReplyId: before.needsAction.replyId }, adminCookie);
      assert.deepEqual([recorded.status, recorded.json.success, recorded.json.replay, recorded.json.row.stage,
        recorded.json.row.needsAction, recorded.json.row.stageSource], [200, true, false, 'nda-sent', null, 'owner']);
      assert.notEqual(recorded.json.row.latestEventId, 'genesis');
      assert.equal(typeof recorded.json.row.gmailThreadUrl, 'string');
      assert.deepEqual(recorded.json.row.release, before.release); // the campaign is untouched

      tick();
      const undo = await post(origin, 'opp-auto', 'stage', { stage: 'broker-replied', idempotencyKey: randomUUID(),
        expectedLatestEventId: recorded.json.row.latestEventId }, adminCookie);
      assert.deepEqual([undo.status, undo.json.row.stage, undo.json.row.needsAction],
        [200, 'broker-replied', null]);
      assert.equal(eventCount('opp-auto'), 2);
    });

    await t.test('not available moves the deal to passed in this tab only: no owner decision, no CRM archive, campaign unchanged', async () => {
      const stored = await world.campaignFor('opp-auto');
      const crmBefore = database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(stored.crm_submission_id);
      const decisionsBefore = database.prepare(
        'SELECT COUNT(*) AS n FROM deal_hunter_owner_decision_events WHERE opportunity_id = ?').get('opp-auto').n;
      const opportunityBefore = database.prepare(
        'SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?').get('opp-auto');
      tick();
      const moved = await post(origin, 'opp-auto', 'reply-type', { replyType: 'not-available',
        idempotencyKey: randomUUID(), expectedLatestEventId: tipOf('opp-auto') }, adminCookie);
      assert.deepEqual([moved.status, moved.json.row.stage, moved.json.row.passedInDealHunter,
        moved.json.row.opportunityActive], [200, 'passed', false, true]);
      assert.deepEqual(await world.campaignFor('opp-auto'), stored);
      assert.deepEqual(database.prepare('SELECT * FROM contact_submissions WHERE id = ?').get(stored.crm_submission_id),
        crmBefore);
      assert.deepEqual(database.prepare('SELECT * FROM deal_hunter_opportunities WHERE opportunity_id = ?')
        .get('opp-auto'), opportunityBefore);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_owner_decision_events WHERE opportunity_id = ?')
        .get('opp-auto').n, decisionsBefore);
      assert.deepEqual(moved.json.row.release.campaign, { id: stored.id, state: stored.state,
        rowVersion: Number(stored.row_version), terminalRevision: Number(stored.terminal_revision) });

      tick(); // put it back so the later tests start from a live deal
      const back = await post(origin, 'opp-auto', 'stage', { stage: 'broker-replied', idempotencyKey: randomUUID(),
        expectedLatestEventId: moved.json.row.latestEventId }, adminCookie);
      assert.equal(back.json.row.stage, 'broker-replied');
    });

    await t.test('two replies then one click: the later reply still needs action', async () => {
      const insert = database.prepare(`INSERT INTO deal_hunter_gmail_reply_messages (gmail_message_id,
        gmail_thread_id, conversation_id, classification, from_fingerprint, message_at, processed_at, applied)
        VALUES (?, ?, ?, ?, NULL, ?, ?, 1)`);
      const second = pacific('2030-01-07', '15:20');
      const third = pacific('2030-01-07', '15:25');
      insert.run('later-reply-2', threadId, campaign.conversation_id, 'reply', second, second);
      insert.run('later-reply-3', threadId, campaign.conversation_id, 'reply', third, third);
      const waiting = await rowOf('opp-auto');
      assert.deepEqual([waiting.needsAction.reason, waiting.needsAction.replyId], ['reply', 'later-reply-2']);

      world.clock.set(pacific('2030-01-07', '15:30'));
      const clicked = await post(origin, 'opp-auto', 'reply-type', { replyType: 'question', idempotencyKey: randomUUID(),
        expectedLatestEventId: waiting.latestEventId, acknowledgedReplyId: 'later-reply-2' }, adminCookie);
      assert.equal(clicked.status, 200);
      assert.deepEqual([clicked.json.row.needsAction.replyId, clicked.json.row.needsAction.reason],
        ['later-reply-3', 'reply']);

      world.clock.set(pacific('2030-01-07', '15:31'));
      const cleared = await post(origin, 'opp-auto', 'acknowledge', { acknowledgedReplyId: 'later-reply-3',
        idempotencyKey: randomUUID() }, adminCookie);
      assert.deepEqual([cleared.status, cleared.json.row.needsAction, cleared.json.row.stage], [200, null, 'broker-replied']);
    });

    await t.test('acknowledge clears a bounce row', async () => {
      database.prepare(`UPDATE deal_hunter_cim_campaigns SET state = 'action-required', reason_code = 'recipient_bounced'
        WHERE id = ?`).run(campaign.id);
      const bounceAt = pacific('2030-01-07', '15:40');
      database.prepare(`INSERT INTO deal_hunter_gmail_reply_messages (gmail_message_id, gmail_thread_id,
        conversation_id, classification, from_fingerprint, message_at, processed_at, applied)
        VALUES ('bounce-1', ?, ?, 'bounce', NULL, ?, ?, 1)`).run(threadId, campaign.conversation_id, bounceAt, bounceAt);
      const waiting = await rowOf('opp-auto');
      assert.deepEqual([waiting.needsAction.reason, waiting.needsAction.replyId, waiting.needsAction.classification],
        ['bounce', 'bounce-1', 'bounce']);
      world.clock.set(pacific('2030-01-07', '15:41'));
      const cleared = await post(origin, 'opp-auto', 'acknowledge', { acknowledgedReplyId: 'bounce-1',
        idempotencyKey: randomUUID() }, adminCookie);
      assert.deepEqual([cleared.status, cleared.json.row.needsAction], [200, null]);
    });

    await t.test('a stale expectedLatestEventId is 409 pursuit_stage_changed; same key replays; same key other body is 409 idempotency_conflict', async () => {
      const tip = tipOf('opp-nda');
      assert.notEqual(tip, 'genesis');
      const key = randomUUID();
      const body = { stage: 'loi-candidate', idempotencyKey: key, expectedLatestEventId: tip };
      const eventsBefore = eventCount('opp-nda');

      world.clock.set(pacific('2030-01-07', '15:50'));
      const stale = await post(origin, 'opp-nda', 'stage', { ...body, idempotencyKey: randomUUID(),
        expectedLatestEventId: 'genesis' }, adminCookie);
      assert.deepEqual([stale.status, stale.json.success, stale.json.code], [409, false, 'pursuit_stage_changed']);
      assert.equal(typeof stale.json.error, 'string');
      assert.equal(eventCount('opp-nda'), eventsBefore);

      const applied = await post(origin, 'opp-nda', 'stage', body, adminCookie);
      assert.deepEqual([applied.status, applied.json.replay, applied.json.row.stage], [200, false, 'loi-candidate']);
      const replay = await post(origin, 'opp-nda', 'stage', body, adminCookie);
      assert.deepEqual([replay.status, replay.json.success, replay.json.replay, replay.json.row.stage,
        replay.json.row.latestEventId], [200, true, true, 'loi-candidate', applied.json.row.latestEventId]);
      assert.equal(eventCount('opp-nda'), eventsBefore + 1);

      const reused = await post(origin, 'opp-nda', 'stage', { ...body, stage: 'financial-review' }, adminCookie);
      assert.deepEqual([reused.status, reused.json.code], [409, 'idempotency_conflict']);
      assert.equal(eventCount('opp-nda'), eventsBefore + 1);
    });

    await t.test('a reply-type retry still replays after the derived stage moved on', async () => {
      const body = { replyType: 'question', idempotencyKey: randomUUID(), expectedLatestEventId: tipOf('opp-plain') };
      world.clock.set(pacific('2030-01-07', '15:51'));
      const first = await post(origin, 'opp-plain', 'reply-type', body, adminCookie);
      assert.deepEqual([first.status, first.json.row.stage], [200, 'broker-replied']);
      world.clock.set(pacific('2030-01-07', '15:52'));
      const moved = await post(origin, 'opp-plain', 'stage', { stage: 'loi-candidate', idempotencyKey: randomUUID(),
        expectedLatestEventId: first.json.row.latestEventId }, adminCookie);
      assert.equal(moved.json.row.stage, 'loi-candidate');
      const retry = await post(origin, 'opp-plain', 'reply-type', body, adminCookie);
      assert.deepEqual([retry.status, retry.json.replay, retry.json.row.stage], [200, true, 'loi-candidate']);
    });

    await t.test('viewer and anonymous writes are 401 and write nothing', async () => {
      const eventsBefore = database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events').get().n;
      const bodies = { 'reply-type': { replyType: 'question', idempotencyKey: randomUUID(), expectedLatestEventId: 'genesis' },
        stage: { stage: 'passed', idempotencyKey: randomUUID(), expectedLatestEventId: 'genesis' },
        acknowledge: { acknowledgedReplyId: 'later-reply-2', idempotencyKey: randomUUID() } };
      for (const [action, body] of Object.entries(bodies)) {
        for (const cookie of [viewerCookie, null]) {
          const response = await post(origin, 'opp-nda', action, body, cookie);
          assert.deepEqual([response.status, response.json], [401, { success: false, error: 'Administrator access is required.' }]);
        }
      }
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events').get().n, eventsBefore);
    });

    await t.test('unknown reply id is 422 unknown_reply; a watched, passed-in-Deal-Hunter or missing deal is 404 not_pursued', async () => {
      const eventsBefore = database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events').get().n;
      const unknown = await post(origin, 'opp-auto', 'acknowledge', { acknowledgedReplyId: 'no-such-reply',
        idempotencyKey: randomUUID() }, adminCookie);
      assert.deepEqual([unknown.status, unknown.json.success, unknown.json.code], [422, false, 'unknown_reply']);
      // A reply that belongs to another deal's conversation is just as unknown.
      const foreign = await post(origin, 'opp-nda', 'acknowledge', { acknowledgedReplyId: 'later-reply-2',
        idempotencyKey: randomUUID() }, adminCookie);
      assert.deepEqual([foreign.status, foreign.json.code], [422, 'unknown_reply']);

      const at = pacific('2030-01-07', '16:00');
      await seedPursuedDeal(storage, 'opp-watched', pacific('2030-01-07', '11:00'));
      await seedPursuedDeal(storage, 'opp-passed-in-dh', pacific('2030-01-07', '11:00'));
      const decide = database.prepare(`INSERT INTO deal_hunter_owner_decision_events (id, idempotency_key,
        request_digest, opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
        observed_discovery_revision, observed_material_revision, policy_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'owner-decision-v1', ?)`);
      decide.run('watch-opp-watched', 'watch-key-1', 'd'.repeat(64), 'opp-watched', 'watch', OWNER, at);
      decide.run('pass-opp-passed-in-dh', 'pass-key-1', 'd'.repeat(64), 'opp-passed-in-dh', 'pass', OWNER, at);
      for (const opportunityId of ['opp-watched', 'opp-passed-in-dh', 'no-such-opportunity', 'bad%20id']) {
        for (const [action, body] of [
          ['reply-type', { replyType: 'question', idempotencyKey: randomUUID(), expectedLatestEventId: 'genesis' }],
          ['stage', { stage: 'passed', idempotencyKey: randomUUID(), expectedLatestEventId: 'genesis' }],
          ['acknowledge', { acknowledgedReplyId: 'later-reply-2', idempotencyKey: randomUUID() }]]) {
          const response = await post(origin, opportunityId, action, body, adminCookie);
          assert.deepEqual([opportunityId, action, response.status, response.json.success, response.json.code],
            [opportunityId, action, 404, false, 'not_pursued']);
        }
      }
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events').get().n, eventsBefore);
    });

    await t.test('an archived opportunity is 409 opportunity_not_active', async () => {
      const response = await post(origin, 'warmup-opp-0', 'stage', { stage: 'passed', idempotencyKey: randomUUID(),
        expectedLatestEventId: 'genesis' }, adminCookie);
      assert.deepEqual([response.status, response.json.code], [409, 'opportunity_not_active']);
    });

    await t.test('bad bodies are 400 with a named code and write nothing', async () => {
      const eventsBefore = database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events').get().n;
      const ok = { idempotencyKey: randomUUID(), expectedLatestEventId: tipOf('opp-nda') };
      const cases = [
        ['reply-type', { ...ok, replyType: 'bogus' }, 'invalid_reply_type'],
        ['reply-type', { ...ok }, 'invalid_reply_type'],
        ['stage', { ...ok, stage: 'bogus' }, 'invalid_stage'],
        ['stage', { ...ok }, 'invalid_stage'],
        ['stage', { stage: 'passed', expectedLatestEventId: ok.expectedLatestEventId }, 'invalid_idempotency_key'],
        ['stage', { stage: 'passed', expectedLatestEventId: ok.expectedLatestEventId, idempotencyKey: 'not-a-uuid' }, 'invalid_idempotency_key'],
        ['reply-type', { replyType: 'question', idempotencyKey: ok.idempotencyKey }, 'invalid_expected_latest_event_id'],
        ['stage', { stage: 'passed', idempotencyKey: ok.idempotencyKey, expectedLatestEventId: null }, 'invalid_expected_latest_event_id'],
        ['stage', { stage: 'passed', idempotencyKey: ok.idempotencyKey, expectedLatestEventId: 'a b' }, 'invalid_expected_latest_event_id'],
        ['reply-type', { ...ok, replyType: 'question', acknowledgedReplyId: 42 }, 'invalid_acknowledged_reply_id'],
        ['acknowledge', { idempotencyKey: ok.idempotencyKey }, 'invalid_acknowledged_reply_id'],
        ['acknowledge', { idempotencyKey: ok.idempotencyKey, acknowledgedReplyId: '' }, 'invalid_acknowledged_reply_id'],
      ];
      for (const [action, body, code] of cases) {
        const response = await post(origin, 'opp-nda', action, body, adminCookie);
        assert.deepEqual([action, response.status, response.json.success, response.json.code],
          [action, 400, false, code], JSON.stringify(body));
      }
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events').get().n, eventsBefore);
    });

    // ---- Task 7: the owner's streaming SIM upload ----
    // A deal the owner requested a SIM on: its campaign is live, so an upload stops it.
    world.clock.set(pacific('2030-01-07', '16:30'));
    await seedDeal(world, { opportunityId: 'opp-sim', name: 'Bayside HVAC', fitScore: 82, criteriaGroup: 'review',
      brokerEmail: 'casey.park@simbroker.test' });
    await ownerRequestsSim(world, 'opp-sim');
    const simCampaign = await world.campaignFor('opp-sim');
    assert.equal(typeof simCampaign.crm_submission_id, 'string');
    const storageDir = process.env.SECURE_DOCUMENTS_STORAGE_DIR;
    const documentCount = () => database.prepare('SELECT COUNT(*) AS n FROM secure_documents').get().n;
    const documentRow = (id) => database.prepare('SELECT * FROM secure_documents WHERE id = ?').get(id);
    const simEvents = () => database.prepare(
      "SELECT COUNT(*) AS n FROM deal_hunter_pursuit_stage_events WHERE kind = 'sim-intake'").get().n;
    const upload = (opportunityId, body, { key, name = 'Acme-SIM.pdf', length = body.length } = {}) =>
      openUpload(origin, opportunityId, { cookie: adminCookie, headers: simHeaders({ key, name, length }), body });
    let firstUpload;

    await t.test('a PDF upload stores a 0600 file, marks SIM received, and stops follow-ups', async () => {
      world.clock.set(pacific('2030-01-07', '16:40'));
      assert.equal(simCampaign.state, 'initial-pending');
      const sentBefore = world.mailProvider.sent.length;
      const key = randomUUID();
      const sent = upload('opp-sim', pdfBytes, { key, name: encodeURIComponent('Acme SIM (final).pdf') });
      const response = await sent.response;
      assert.equal(response.status, 201, response.body);
      assert.equal(response.json.success, true);
      assert.equal(response.json.row.stage, 'cim-received');
      assert.equal(response.json.stoppedFollowUps, true);
      assert.equal(bodyBytesRead.get(sent.tag), pdfBytes.length);

      const stored = documentRow(response.json.document.id);
      assert.deepEqual(response.json.document, { id: stored.id, name: 'Acme-SIM-final-.pdf', sizeBytes: pdfBytes.length,
        uploadedAt: stored.created_at });
      assert.deepEqual([stored.document_type, stored.submission_id, stored.mime_type, stored.file_name],
        ['cim', simCampaign.crm_submission_id, 'application/pdf', `${stored.id}-Acme-SIM-final-.pdf`]);
      const storedPath = path.join(storageDir, stored.request_id, stored.file_name);
      assert.equal(stored.storage_path, storedPath);
      assert.equal((fs.statSync(storedPath).mode & 0o777), 0o600);
      assert.equal((fs.statSync(path.dirname(storedPath)).mode & 0o777), 0o700);
      assert.deepEqual(fs.readFileSync(storedPath), pdfBytes);
      assert.equal((await world.campaignFor('opp-sim')).state, 'materials-received');
      assert.equal(response.json.row.simDocuments[0].id, stored.id);

      const request = database.prepare('SELECT * FROM secure_upload_requests WHERE id = ?').get(stored.request_id);
      assert.deepEqual([request.status, request.requested_by, request.nda_required, request.closed_at],
        ['completed', 'admin', 0, request.expires_at]);
      const event = database.prepare(`SELECT kind, secure_document_id, actor FROM deal_hunter_pursuit_stage_events
        WHERE idempotency_key = ?`).get(key);
      assert.deepEqual({ ...event }, { kind: 'sim-intake', secure_document_id: stored.id, actor: 'admin' });
      const activity = database.prepare(`SELECT role, opportunity_id FROM crm_activity_events
        WHERE submission_id = ? AND event_type = 'documents.uploaded'`).all(stored.submission_id);
      assert.deepEqual(activity.map((row) => ({ ...row })), [{ role: 'admin', opportunity_id: 'opp-sim' }]);

      // The write-ahead cleanup job, settled: no requestId, so the reconciler never resets the request.
      const [job] = database.prepare('SELECT * FROM secure_document_cleanup_jobs WHERE files LIKE ?')
        .all(`%${stored.id}%`);
      assert.equal(job.status, 'completed');
      const metadata = JSON.parse(job.metadata);
      assert.deepEqual(metadata, { reason: 'ambiguous-secure-upload-finalization', documentIds: [stored.id],
        reconcileAfter: metadata.reconcileAfter, writeAheadIntent: true });
      assert.equal(Number.isFinite(Date.parse(metadata.reconcileAfter)), true);
      assert.deepEqual(JSON.parse(job.files), [{ documentId: stored.id, originalPath: storedPath,
        stagedPath: path.join(job.trash_directory, `0-${stored.file_name}`), staged: false,
        purgeOriginalIfStagedMissing: true }]);
      assert.equal(world.mailProvider.sent.length, sentBefore); // the upload sends nothing
      assert.deepEqual(vaultLitter(), []);
      firstUpload = { key, response };
    });

    await t.test('anonymous and viewer uploads are 401 before any body byte is read', async () => {
      const documents = documentCount();
      for (const cookie of [null, viewerCookie]) {
        const held = openUpload(origin, 'opp-sim', { cookie, headers: simHeaders({ length: pdfBytes.length }),
          hold: true });
        const response = await held.response;
        assert.deepEqual([response.status, response.json], [401,
          { success: false, error: 'Administrator access is required.' }]);
        assert.equal(bodyBytesRead.get(held.tag), 0);
        held.request.destroy();
      }
      assert.equal(documentCount(), documents);
    });

    let holders;
    await t.test('a full capacity gate is 503 with Retry-After 30 before any body byte is read', async () => {
      // Two uploads hold both slots mid-stream.
      holders = [0, 1].map(() => openUpload(origin, 'opp-sim', { cookie: adminCookie,
        headers: simHeaders({ length: pdfBytes.length }), body: pdfBytes.subarray(0, 4096), hold: true }));
      await waitFor(() => holders.every((held) => bodyBytesRead.get(held.tag) === 4096), 'both uploads to stream');
      const refused = openUpload(origin, 'opp-sim', { cookie: adminCookie,
        headers: simHeaders({ length: pdfBytes.length }), hold: true });
      const response = await refused.response;
      assert.deepEqual([response.status, response.headers['retry-after'], response.json], [503, '30',
        { success: false, code: 'upload_capacity', error: 'Uploads are busy. Try again in 30 seconds.' }]);
      assert.equal(bodyBytesRead.get(refused.tag), 0);
      refused.request.destroy();
    });

    await t.test('a client abort mid-stream leaves no file and frees the capacity slot', async () => {
      const documents = documentCount();
      await waitFor(() => vaultLitter().length === 2, 'the two partial files');
      for (const held of holders) held.request.destroy();
      for (const held of holders) assert.ok((await held.response).error);
      await waitFor(() => vaultLitter().length === 0 && unsettledCleanupJobs().length === 0,
        'the aborted uploads to be cleaned up');
      // Both slots are free again: two more uploads stream at the same time.
      const again = [0, 1].map(() => openUpload(origin, 'opp-sim', { cookie: adminCookie,
        headers: simHeaders({ length: pdfBytes.length }), body: pdfBytes.subarray(0, 4096), hold: true }));
      await waitFor(() => again.every((held) => bodyBytesRead.get(held.tag) === 4096), 'two uploads to stream');
      for (const held of again) held.request.destroy();
      await waitFor(() => vaultLitter().length === 0 && unsettledCleanupJobs().length === 0,
        'the second aborted uploads to be cleaned up');
      assert.equal(documentCount(), documents);
    });

    await t.test('header refusals: 415 pdf_only, 411 length_required, 413 by header, 400 invalid_idempotency_key, 400 invalid_file_name for %E0%A4%A', async () => {
      const documents = documentCount();
      const ok = simHeaders({ length: 100 });
      const { 'Content-Length': _length, ...chunked } = ok;
      const cases = [
        [{ ...ok, 'Content-Type': 'application/octet-stream' }, 415, 'pdf_only', 'Only PDF files can be uploaded as a SIM.'],
        [{ ...ok, 'Content-Type': 'application/pdf; charset=binary' }, 415, 'pdf_only'],
        [{ ...ok, 'Content-Type': 'text/html', 'Content-Length': String(SIM_MAX_BYTES + 1) }, 415, 'pdf_only'],
        [{ ...chunked, 'Transfer-Encoding': 'chunked' }, 411, 'length_required'],
        [{ ...ok, 'Content-Length': String(SIM_MAX_BYTES + 1) }, 413, 'file_too_large', 'This file is larger than 25 MB.'],
        [{ ...ok, 'Content-Length': String(SIM_MAX_BYTES + 1), 'X-Idempotency-Key': 'nope' }, 413, 'file_too_large'],
        [{ ...ok, 'X-Idempotency-Key': 'not-a-uuid', 'X-File-Name': '%E0%A4%A' }, 400, 'invalid_idempotency_key'],
        [{ ...ok, 'X-File-Name': '%E0%A4%A' }, 400, 'invalid_file_name',
          'The file name couldn\'t be read. Rename it and try again.'],
      ];
      for (const [headers, status, code, copy] of cases) {
        const held = openUpload(origin, 'opp-sim', { cookie: adminCookie, headers, hold: true });
        const response = await held.response;
        assert.deepEqual([response.status, response.json.success, response.json.code], [status, false, code],
          JSON.stringify(headers));
        if (copy) assert.equal(response.json.error, copy);
        assert.equal(bodyBytesRead.get(held.tag), 0);
        held.request.destroy();
      }
      assert.equal(documentCount(), documents);
    });

    await t.test('a body longer than its Content-Length or 25 MiB is 413 and leaves no file', async () => {
      // Node's HTTP parser never hands a request stream more than its Content-Length, so the
      // stream check is driven directly with request streams that overrun it.
      const { SIM_MAX_BYTES: maxBytes, receivePursuitSimUpload } = await import('../server/services/pursuedDealsSimUpload.js');
      assert.equal(maxBytes, SIM_MAX_BYTES);
      const documents = documentCount();
      const events = simEvents();
      const receive = (request, contentLength) => receivePursuitSimUpload({ storage, config: getConfig(), request,
        opportunityId: 'opp-sim', actor: 'admin', role: 'admin',
        headers: { idempotencyKey: randomUUID(), fileName: 'Long.pdf', contentLength, acknowledgedReplyId: null },
        diskStats: async () => ({ bavail: 2 ** 30, bsize: 4096 }) });
      const longer = await receive(Readable.from([pdfBytes, Buffer.alloc(10)]), pdfBytes.length);
      assert.deepEqual([longer.status, longer.body.code], [413, 'file_too_large']);
      const mebibyte = Buffer.alloc(1024 * 1024, 0x20);
      function* overMax() {
        yield Buffer.from('%PDF-');
        for (let index = 0; index < 25; index += 1) yield mebibyte;
      }
      const huge = await receive(Readable.from(overMax()), SIM_MAX_BYTES);
      assert.deepEqual([huge.status, huge.body.code], [413, 'file_too_large']);
      // A stream that ends short of its Content-Length is refused too.
      const shorter = await receive(Readable.from([pdfBytes.subarray(0, 100)]), pdfBytes.length);
      assert.deepEqual([shorter.status, shorter.body.code], [411, 'length_required']);
      assert.deepEqual([documentCount(), simEvents(), vaultLitter(), unsettledCleanupJobs()],
        [documents, events, [], []]);
    });

    await t.test('a PNG renamed .pdf is 422 not_a_pdf and leaves no file', async () => {
      const documents = documentCount();
      const events = simEvents();
      const response = await upload('opp-sim', pngBytes, { name: 'scan.pdf' }).response;
      assert.deepEqual([response.status, response.json], [422,
        { success: false, code: 'not_a_pdf', error: 'That file isn\'t a valid PDF.' }]);
      const tiny = await upload('opp-sim', Buffer.from('%PD'), { name: 'tiny.pdf' }).response;
      assert.deepEqual([tiny.status, tiny.json.code], [422, 'not_a_pdf']);
      assert.deepEqual([documentCount(), simEvents(), vaultLitter(), unsettledCleanupJobs()],
        [documents, events, [], []]);
    });

    await t.test('../../etc/x.pdf is stored as a sanitized basename inside the request directory', async () => {
      for (const [name, expected] of [[encodeURIComponent('../../etc/x.pdf'), 'x.pdf'], ['..%2F..%2Fetc%2Fx.pdf', 'x.pdf'],
        [encodeURIComponent('Q3 numbers'), 'Q3-numbers.pdf'], ['a'.repeat(200), `${'a'.repeat(176)}.pdf`]]) {
        world.clock.set(new Date(Date.now() + 60_000).toISOString());
        const response = await upload('opp-sim', pdfBytes, { name }).response;
        assert.equal(response.status, 201, response.body);
        const stored = documentRow(response.json.document.id);
        assert.deepEqual([stored.original_name, response.json.document.name], [expected, expected]);
        assert.equal(stored.storage_path, path.join(storageDir, stored.request_id, `${stored.id}-${expected}`));
        assert.equal(path.relative(storageDir, stored.storage_path).startsWith('..'), false);
        assert.equal(fs.existsSync(stored.storage_path), true);
      }
      assert.equal(fs.existsSync(path.join(storageDir, '..', 'etc')), false);
      assert.deepEqual(vaultLitter(), []);
    });

    await t.test('507 storage_full when diskStats reports less than the reserve', async () => {
      const documents = documentCount();
      const jobs = database.prepare('SELECT COUNT(*) AS n FROM secure_document_cleanup_jobs').get().n;
      const asked = [];
      await withServer(async (lowOrigin) => {
        const held = openUpload(lowOrigin, 'opp-sim', { cookie: adminCookie,
          headers: simHeaders({ length: pdfBytes.length }), hold: true });
        const response = await held.response;
        assert.deepEqual([response.status, response.json], [507, { success: false, code: 'storage_full',
          error: 'The server is low on storage space. Tell your engineer before uploading more.' }]);
        held.request.destroy();
      }, { diskStats: async (directory) => { asked.push(directory); return { bavail: 1, bsize: 4096 }; } });
      assert.deepEqual(asked, [storageDir]);
      assert.equal(documentCount(), documents);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM secure_document_cleanup_jobs').get().n, jobs);
      assert.deepEqual(vaultLitter(), []);
    });

    await t.test('a replayed key returns the first result without reading the body', async () => {
      const documents = documentCount();
      const events = simEvents();
      const held = openUpload(origin, 'opp-sim', { cookie: adminCookie,
        headers: simHeaders({ key: firstUpload.key, length: pdfBytes.length }), hold: true });
      const response = await held.response;
      assert.deepEqual([response.status, response.json.success, response.json.replay, response.json.row.opportunityId],
        [200, true, true, 'opp-sim']);
      assert.equal(response.json.row.simDocuments.some((document) => document.id === firstUpload.response.json.document.id),
        true);
      assert.equal(bodyBytesRead.get(held.tag), 0);
      await waitFor(() => held.request.socket?.destroyed, 'the server to close the replayed upload');
      assert.deepEqual([documentCount(), simEvents()], [documents, events]);

      // A key another write already used is a conflict, not a replay.
      const { idempotency_key: usedKey } = database.prepare(
        "SELECT idempotency_key FROM deal_hunter_pursuit_stage_events WHERE kind = 'stage-move' LIMIT 1").get();
      const reused = await openUpload(origin, 'opp-sim', { cookie: adminCookie,
        headers: simHeaders({ key: usedKey, length: pdfBytes.length }), hold: true }).response;
      assert.deepEqual([reused.status, reused.json.code], [409, 'idempotency_conflict']);
      assert.deepEqual([documentCount(), simEvents()], [documents, events]);
    });

    await t.test('no campaign is 409 no_crm_record', async () => {
      await seedPursuedDeal(storage, 'opp-sim-no-crm', pacific('2030-01-07', '12:00'));
      const documents = documentCount();
      const held = openUpload(origin, 'opp-sim-no-crm', { cookie: adminCookie,
        headers: simHeaders({ length: pdfBytes.length }), hold: true });
      const response = await held.response;
      assert.deepEqual([response.status, response.json], [409, { success: false, code: 'no_crm_record',
        error: 'This deal has no CRM record yet, so a SIM can\'t be stored.' }]);
      assert.equal(bodyBytesRead.get(held.tag), 0);
      held.request.destroy();
      const missing = await openUpload(origin, 'no-such-deal', { cookie: adminCookie,
        headers: simHeaders({ length: pdfBytes.length }), hold: true }).response;
      assert.deepEqual([missing.status, missing.json.code], [404, 'not_pursued']);
      assert.equal(documentCount(), documents);
      assert.deepEqual(vaultLitter(), []);
    });

    await t.test('no address for the synthetic request is 409 no_crm_record before the body, with no file and no cleanup job', async () => {
      const { receivePursuitSimUpload } = await import('../server/services/pursuedDealsSimUpload.js');
      const config = getConfig();
      // The CRM record has no email, Gmail is not connected, and no sender address is configured.
      const noAddress = storageWith(storage, {
        getSubmission: async (id) => ({ ...(await storage.getSubmission(id)), email: '' }),
        getGmailConnection: async () => null,
      });
      const noSender = { ...config, dealHunter: { ...config.dealHunter,
        gmail: { ...config.dealHunter.gmail, senderAddress: '' } } };
      let bodyRead = false;
      const request = new Readable({ read() { bodyRead = true; this.push(pdfBytes); this.push(null); } });
      const documents = documentCount();
      const events = simEvents();
      const jobs = database.prepare('SELECT COUNT(*) AS n FROM secure_document_cleanup_jobs').get().n;
      const result = await receivePursuitSimUpload({ storage: noAddress, config: noSender, request,
        opportunityId: 'opp-sim', actor: 'admin', role: 'admin',
        headers: { idempotencyKey: randomUUID(), fileName: 'No-address.pdf', contentLength: pdfBytes.length,
          acknowledgedReplyId: null },
        diskStats: async () => ({ bavail: 2 ** 30, bsize: 4096 }) });
      assert.deepEqual([result.status, result.body], [409, { success: false, code: 'no_crm_record',
        error: 'This deal has no CRM record yet, so a SIM can\'t be stored.' }]);
      assert.equal(bodyRead, false);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM secure_document_cleanup_jobs').get().n, jobs);
      assert.deepEqual([documentCount(), simEvents(), vaultLitter()], [documents, events, []]);
    });

    await t.test('an upload during a backup leaves both consistent', async () => {
      world.clock.set(new Date(Date.now() + 60_000).toISOString());
      const backup = createBackupBundle({ storage, config: getConfig() });
      const sent = upload('opp-sim', pdfBytes, { name: 'during-backup.pdf' });
      const [bundle, response] = await Promise.all([backup, sent.response]);
      assert.equal(response.status, 201, response.body);
      assert.equal((await verifyBackupBundle(bundle.path)).ok, true);
      const stored = documentRow(response.json.document.id);
      assert.ok(stored);
      assert.deepEqual(fs.readFileSync(stored.storage_path), pdfBytes);
      assert.deepEqual([vaultLitter(), unsettledCleanupJobs()], [[], []]);
    });

    await t.test('a row read-back that throws after the commit still answers 201, with row null', async (st) => {
      world.clock.set(new Date(Date.now() + 60_000).toISOString());
      const { receivePursuitSimUpload } = await import('../server/services/pursuedDealsSimUpload.js');
      const errors = [];
      st.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
      let committed = false;
      const flaky = storageWith(storage, {
        recordPursuitSimIntake: async (command) => {
          const result = await storage.recordPursuitSimIntake(command);
          committed = true;
          return result;
        },
        listPursuitBundles: async (...args) => {
          if (committed) throw new Error('read-back failed');
          return storage.listPursuitBundles(...args);
        },
      });
      const events = simEvents();
      const result = await receivePursuitSimUpload({ storage: flaky, config: getConfig(), request: Readable.from([pdfBytes]),
        opportunityId: 'opp-sim', actor: 'admin', role: 'admin',
        headers: { idempotencyKey: randomUUID(), fileName: 'Read-back.pdf', contentLength: pdfBytes.length,
          acknowledgedReplyId: null },
        diskStats: async () => ({ bavail: 2 ** 30, bsize: 4096 }) });
      assert.equal(committed, true);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.deepEqual([result.body.success, result.body.row], [true, null]);
      const stored = documentRow(result.body.document.id);
      assert.ok(stored, 'the document row exists');
      assert.deepEqual(fs.readFileSync(stored.storage_path), pdfBytes);
      assert.equal(simEvents(), events + 1);
      assert.deepEqual([vaultLitter(), unsettledCleanupJobs()], [[], []]);
      assert.equal(errors.some((line) => line.includes(stored.id) && line.includes('read-back failed')), true);
    });

    await t.test('SIM upload answers carry the same security headers as the other admin routes', async () => {
      const SECURITY_HEADERS = ['content-security-policy', 'permissions-policy', 'referrer-policy',
        'x-content-type-options', 'x-frame-options', 'cache-control', 'pragma'];
      const pick = (headers) => Object.fromEntries(SECURITY_HEADERS.map((name) => [name, headers.get?.(name)
        ?? headers[name] ?? null]));
      const expected = pick((await fetch(`${origin}${route}`, { headers: { Cookie: adminCookie } })).headers);
      assert.equal(expected['x-content-type-options'], 'nosniff');
      assert.equal(expected['x-frame-options'], 'DENY');
      assert.ok(expected['content-security-policy']);

      world.clock.set(new Date(Date.now() + 60_000).toISOString());
      const stored = await upload('opp-sim', pdfBytes, { name: 'headers.pdf' }).response;
      assert.equal(stored.status, 201, stored.body);
      const refused = openUpload(origin, 'opp-sim', { cookie: adminCookie,
        headers: simHeaders({ length: 100, type: 'text/plain' }), hold: true });
      const refusal = await refused.response;
      refused.request.destroy();
      assert.equal(refusal.status, 415);
      const anonymous = openUpload(origin, 'opp-sim', { headers: simHeaders({ length: 100 }), hold: true });
      const unauthorized = await anonymous.response;
      anonymous.request.destroy();
      assert.equal(unauthorized.status, 401);
      for (const answer of [stored, refusal, unauthorized]) {
        assert.deepEqual(pick(answer.headers), expected, `status ${answer.status}`);
      }
    });
  });
});
