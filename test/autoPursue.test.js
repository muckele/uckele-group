import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-auto-pursue-'));
process.env.ADMIN_SESSION_SECRET = 'auto-pursue-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'auto-pursue-document-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'default.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;
delete process.env.DEAL_HUNTER_AUTO_PURSUE_ACTIVE_DAILY_CAP;

const { createSqliteStorage } = await import('../server/storage/sqlite.js');
const { recordAcquisitionOwnerCommand } = await import('../server/services/dealHunterTriage.js');
const { setCurrentOperatorOpportunityFact } = await import('../server/services/dealHunterOpportunityFacts.js');
const { ownerBusinessDate } = await import('../server/services/dealHunterFreshInboxPolicy.js');
const {
  AUTO_PURSUE_CONFIRMATIONS, autoPursueIdempotencyKey, getAutoPursueStatus, getAutoPursueWarmup,
  ownerBusinessDateBounds, runAutoPursue, setAutoPursueMode, summarizeAutoPursueWarmup,
} = await import('../server/services/autoPursue.js');

const owner = 'owner@uckele.test';
let storageCount = 0;
const seededIds = new WeakMap();

function freshStorage() {
  storageCount += 1;
  return createSqliteStorage({ storage: { sqlitePath: path.join(tempDir, `run-${storageCount}.sqlite`) } });
}

async function seedAuto(storage, opportunityId, {
  email = `pat.${opportunityId}@brokerfirm.test`, fitScore = 93, criteriaGroup = 'auto',
  criteriaProfileVersion = 'uckele-criteria-v1', brokerEmail = true,
} = {}) {
  const at = '2026-10-30T09:00:00.000Z';
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: at, updated_at: at, canonical_name: `Deal ${opportunityId}`,
    canonical_recipient: null, canonical_location: 'Phoenix, AZ', primary_submission_id: null,
    identity_version: 'auto-pursue-test', status: 'active', metadata: {},
  });
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: opportunityId, scored_at: at, deal_key: `deal-${opportunityId}`,
    name: `HVAC ${opportunityId}`, state: 'AZ', listing_url: `https://broker.example/${opportunityId}`,
    fit_score: fitScore, score_status: 'high-fit', confidence: 'high', completeness_score: 90,
    contradiction_count: 0, missing_evidence_count: 0, should_remove: false, high_fit: true, gate_count: 0,
    score_fingerprint: `fp-${opportunityId}`, semantic_digest: `sd-${opportunityId}`,
    engine_version: 'test', rules_version: 'test', profile_version: 'test', completeness_policy_version: 'test',
    dimensions: [], gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
    criteria_profile_version: criteriaProfileVersion, criteria_group: criteriaGroup,
    criteria_result: { mustHaves: [], failed: [], unknown: [] },
  });
  // Reconciliation replaces the whole eligible set, so pass every seeded opportunity.
  const seeded = seededIds.get(storage) || new Set();
  seeded.add(opportunityId);
  seededIds.set(storage, seeded);
  await storage.reconcileDealHunterCurrentScoreEligibility([...seeded]);
  const fields = [['listing_url', `https://broker.example/${opportunityId}`], ['broker_name', 'Pat Broker']];
  if (brokerEmail) fields.push(['broker_email', email]);
  for (const [field, value] of fields) {
    await storage.upsertDealHunterOpportunitySourceObservation({
      id: `${opportunityId}-${field}`, opportunity_id: opportunityId, source_id: 'sheet-0',
      source_name: 'Synthetic Sheet', source_record_id: `row-${opportunityId}`, field, value,
      observed_at: at, created_at: at, updated_at: at,
    });
  }
  return opportunityId;
}

async function seedWarmup(storage, { auto = 30, autoChanged = 0, other = 0 } = {}) {
  let index = 0;
  const add = async (criteriaGroup, action, unchanged) => {
    index += 1;
    await storage.insertAutoPursueDecisionEvidence({
      decision_event_id: `warmup-event-${index}`, opportunity_id: `warmup-opp-${index}`, action,
      policy_version: 'owner-decision-v1', criteria_group: criteriaGroup,
      criteria_profile_version: 'uckele-criteria-v1', recipient_unchanged: unchanged,
      created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    });
  };
  for (let i = 0; i < auto; i += 1) await add('auto', 'pursue', true);
  for (let i = 0; i < autoChanged; i += 1) await add('auto', 'pursue', false);
  for (let i = 0; i < other; i += 1) await add('review', 'pass', true);
}

async function setMode(storage, mode, extra = {}) {
  const result = await setAutoPursueMode({ mode, confirmation: AUTO_PURSUE_CONFIRMATIONS[mode],
    actor: owner, reason: 'test', storage, ...extra });
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}

async function readyStorage(mode, extra) {
  const storage = freshStorage();
  await seedWarmup(storage);
  if (mode) await setMode(storage, mode, extra);
  return storage;
}

async function autoDecisions(storage) {
  const now = new Date();
  const wide = { since: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
    until: new Date(now.getTime() + 10 * 86_400_000).toISOString() };
  return storage.countOwnerDecisionsByPolicy({ policyVersion: 'auto-pursue-v1', ...wide });
}

async function scoreRow(storage, opportunityId) {
  return storage.getDealHunterOpportunityScore(opportunityId);
}

const reasonFor = (result, opportunityId) => result.skipped.find((item) => item.opportunityId === opportunityId)?.reason;

test('idempotency key is a deterministic version-8 UUID accepted by the owner command validator', () => {
  const key = autoPursueIdempotencyKey('2026-11-02', 'opp-1');
  assert.equal(key, autoPursueIdempotencyKey('2026-11-02', 'opp-1'));
  assert.notEqual(key, autoPursueIdempotencyKey('2026-11-03', 'opp-1'));
  assert.notEqual(key, autoPursueIdempotencyKey('2026-11-02', 'opp-2'));
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('owner business date bounds follow Pacific midnight across daylight saving changes', () => {
  assert.deepEqual(ownerBusinessDateBounds('2026-11-02'),
    { since: '2026-11-02T08:00:00.000Z', until: '2026-11-03T08:00:00.000Z' });
  assert.deepEqual(ownerBusinessDateBounds('2026-11-01'),
    { since: '2026-11-01T07:00:00.000Z', until: '2026-11-02T08:00:00.000Z' });
  assert.deepEqual(ownerBusinessDateBounds('2026-03-08'),
    { since: '2026-03-08T08:00:00.000Z', until: '2026-03-09T07:00:00.000Z' });
});

test('ships off: with no activation record the runner records nothing', async () => {
  const storage = freshStorage();
  await seedAuto(storage, 'opp-default-off');
  const status = await getAutoPursueStatus({ storage });
  assert.equal(status.mode, 'off');
  assert.equal(status.dailyCap, 0);
  const result = await runAutoPursue({ storage });
  assert.equal(result.mode, 'off');
  assert.equal(result.commands, 0);
  assert.deepEqual(result.wouldPursue, ['opp-default-off']);
  assert.equal(await autoDecisions(storage), 0);
});

test('off and shadow record no commands but refresh blockers', async () => {
  for (const mode of ['off', 'shadow']) {
    const storage = await readyStorage(mode);
    await seedAuto(storage, `opp-${mode}-clean`);
    await seedAuto(storage, `opp-${mode}-generic`, { email: 'info@brokerfirm.test' });
    const result = await runAutoPursue({ storage });
    assert.equal(result.ok, true);
    assert.equal(result.mode, mode);
    assert.equal(result.commands, 0);
    assert.deepEqual(result.wouldPursue, [`opp-${mode}-clean`]);
    assert.equal(reasonFor(result, `opp-${mode}-generic`), 'generic_mailbox');
    assert.equal((await scoreRow(storage, `opp-${mode}-generic`)).auto_pursue_blocker, 'generic_mailbox');
    assert.equal((await scoreRow(storage, `opp-${mode}-clean`)).auto_pursue_blocker ?? null, null);
    assert.equal(await autoDecisions(storage), 0);
  }
});

test('a cleared cause clears the blocker even though the row had left the auto-pursue area', async () => {
  const storage = await readyStorage('off');
  await seedAuto(storage, 'opp-clears');
  await storage.setDealHunterAutoPursueBlockers([{ opportunityId: 'opp-clears', blocker: 'suppressed',
    checkedAt: new Date().toISOString() }]);
  const inbox = await storage.listDealHunterFreshInbox({ area: 'your-review', limit: 100 });
  assert.ok(inbox.areas[0].rows.some((row) => row.opportunity_id === 'opp-clears'));
  await runAutoPursue({ storage });
  assert.equal((await scoreRow(storage, 'opp-clears')).auto_pursue_blocker ?? null, null);
});

test('blockers are written only when they change', async () => {
  const storage = await readyStorage('off');
  await seedAuto(storage, 'opp-stable-generic', { email: 'sales@brokerfirm.test' });
  await runAutoPursue({ storage });
  const first = await scoreRow(storage, 'opp-stable-generic');
  assert.equal(first.auto_pursue_blocker, 'generic_mailbox');
  const writes = [];
  const original = storage.setDealHunterAutoPursueBlockers;
  storage.setDealHunterAutoPursueBlockers = async (entries) => { writes.push(entries); return original(entries); };
  await runAutoPursue({ storage, now: new Date(Date.now() + 1000) });
  assert.equal(writes.length, 0);
  assert.equal((await scoreRow(storage, 'opp-stable-generic')).auto_pursue_checked_at, first.auto_pursue_checked_at);
});

test('canary records at most one pursue per business date across reruns', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-canary-a');
  await seedAuto(storage, 'opp-canary-b');
  const now = new Date();
  const first = await runAutoPursue({ storage, now });
  assert.equal(first.commands, 1);
  const second = await runAutoPursue({ storage, now });
  assert.equal(second.duplicateInvocation, false);
  assert.equal(second.commands, 0);
  assert.equal(await autoDecisions(storage), 1);
  assert.ok(second.skipped.some((item) => item.reason === 'daily_cap_reached'));
  const status = await getAutoPursueStatus({ storage, now });
  assert.equal(status.mode, 'canary');
  assert.equal(status.dailyCap, 1);
  assert.equal(status.todayCommands, 1);
  assert.equal(status.latestRun.commands, 0);
});

test('automatic Pursue uses the automation actor, the policy version, and the single recipient', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-actor');
  const result = await runAutoPursue({ storage });
  assert.equal(result.commands, 1);
  const projection = await storage.readPursueCimProjection({ opportunityId: 'opp-actor' });
  assert.equal(projection.decision.actor, 'automation-auto-pursue');
  assert.equal(projection.decision.policy_version, 'auto-pursue-v1');
  assert.equal(projection.decision.action, 'pursue');
  assert.equal(projection.decision.idempotency_key,
    autoPursueIdempotencyKey(ownerBusinessDate(new Date()), 'opp-actor'));
  assert.match(projection.decision.selected_contact_reference_digest, /^[0-9a-f]{64}$/);
  assert.equal((await storage.listAutoPursueDecisionEvidence({ policyVersion: 'auto-pursue-v1' })).length, 1);
});

test('active respects the configured cap and the next business date resets it', async () => {
  const storage = await readyStorage('active', { dailyCap: 3 });
  for (const id of ['opp-active-1', 'opp-active-2', 'opp-active-3', 'opp-active-4', 'opp-active-5']) {
    await seedAuto(storage, id);
  }
  const today = new Date();
  const first = await runAutoPursue({ storage, now: today });
  assert.equal(first.commands, 3);
  assert.equal(first.skipped.filter((item) => item.reason === 'daily_cap_reached').length, 2);
  assert.equal(await autoDecisions(storage), 3);
  // Decisions are stamped with the wall clock, so "tomorrow" sees none of today's.
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const second = await runAutoPursue({ storage, now: tomorrow });
  assert.equal(second.commands, 2);
  assert.equal(await autoDecisions(storage), 5);
});

test('active daily cap is clamped to 1-10 and canary is forced to 1', async () => {
  const storage = await readyStorage();
  assert.equal((await setMode(storage, 'active', { dailyCap: 50 })).activation.dailyCap, 10);
  assert.equal((await setMode(storage, 'active', { dailyCap: 0 })).activation.dailyCap, 3);
  assert.equal((await setMode(storage, 'active', { dailyCap: -4 })).activation.dailyCap, 3);
  assert.equal((await setMode(storage, 'active', { dailyCap: 7 })).activation.dailyCap, 7);
  assert.equal((await setMode(storage, 'canary', { dailyCap: 9 })).activation.dailyCap, 1);
  assert.equal((await setMode(storage, 'shadow', { dailyCap: 9 })).activation.dailyCap, 0);
  const current = await storage.getCurrentAutoPursueActivation();
  assert.equal(current.mode, 'shadow');
});

test('mode changes supersede the current activation atomically', async () => {
  const storage = await readyStorage('shadow');
  await setMode(storage, 'off');
  const current = await storage.getCurrentAutoPursueActivation();
  assert.equal(current.mode, 'off');
  assert.equal(current.status, 'current');
  assert.equal(current.confirmation, 'SET AUTO PURSUE OFF');
});

test('crash after the first command does not duplicate it', async () => {
  const storage = await readyStorage('active', { dailyCap: 1 });
  await seedAuto(storage, 'opp-crash');
  const now = new Date();
  assert.equal((await runAutoPursue({ storage, now })).commands, 1);
  // Simulate a crash that lost the run row after the command committed.
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tempDir, `run-${storageCount}.sqlite`));
  raw.prepare('DELETE FROM deal_hunter_auto_pursue_runs').run();
  raw.close();
  await setMode(storage, 'active', { dailyCap: 2 });
  const rerun = await runAutoPursue({ storage, now });
  assert.equal(rerun.commands, 0);
  assert.equal(reasonFor(rerun, 'opp-crash'), 'owner_decision_exists');
  assert.equal(await autoDecisions(storage), 1);
  // A replay of the same deterministic command also creates nothing new.
  const replay = await recordAcquisitionOwnerCommand({ opportunityId: 'opp-crash', action: 'pursue',
    idempotencyKey: autoPursueIdempotencyKey(ownerBusinessDate(now), 'opp-crash'),
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
    recipientContactRef: (await (await import('../server/services/dealHunterBrokerMaterials.js'))
      .loadBrokerMaterialsAuthority({ opportunityId: 'opp-crash', storage })).recipientOptions[0].recipientContactRef,
    actor: 'automation-auto-pursue', decisionPolicyVersion: 'auto-pursue-v1', storage });
  assert.ok([200, 409].includes(replay.status), JSON.stringify(replay));
  assert.equal(await autoDecisions(storage), 1);
});

test('a run left claimed by a crash is reported as a duplicate invocation and records nothing', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-claimed');
  const now = new Date();
  const businessDate = ownerBusinessDate(now);
  await storage.claimAutoPursueRun({ id: randomUUID(), run_key: `auto-pursue:${businessDate}:canary:0`,
    business_date: businessDate, mode: 'canary', created_at: now.toISOString() });
  const result = await runAutoPursue({ storage, now });
  assert.equal(result.duplicateInvocation, true);
  assert.equal(result.reason, 'run_in_progress');
  assert.equal(result.commands, 0);
  assert.equal(await autoDecisions(storage), 0);
});

test('each blocker skips the row', async () => {
  const storage = await readyStorage('active', { dailyCap: 10 });
  await seedAuto(storage, 'opp-b-identity');
  await storage.upsertDealHunterIdentityException({ id: 'exception-1', created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), status: 'open', candidate_opportunity_ids: ['opp-b-identity'],
    reason: 'ambiguous', evidence_version: 'test' });
  await seedAuto(storage, 'opp-b-zero', { brokerEmail: false });
  await seedAuto(storage, 'opp-b-two');
  await setCurrentOperatorOpportunityFact({ opportunityId: 'opp-b-two', field: 'broker_email',
    value: 'other.broker@brokerfirm.test', actor: owner, verified: true, idempotencyKey: randomUUID(),
    expectedRevision: { campaignAuthorityRevision: Number((await storage.getCurrentDealHunterOpportunity('opp-b-two'))
      .campaign_authority_revision), primarySubmissionId: null, submissionFactSnapshot: null },
    storage });
  await seedAuto(storage, 'opp-b-generic', { email: 'deals@brokerfirm.test' });
  await seedAuto(storage, 'opp-b-prior', { email: 'shared.broker@brokerfirm.test' });
  await storage.upsertDealHunterCimRequest({ id: 'prior-request', deal_key: 'deal-elsewhere',
    recipient_email: 'shared.broker@brokerfirm.test', status: 'sent', created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), metadata: {} });
  await seedAuto(storage, 'opp-b-suppressed', { email: 'gone.broker@brokerfirm.test' });
  await storage.upsertEmailSuppression({ id: randomUUID(), normalized_email: 'gone.broker@brokerfirm.test',
    reason: 'unsubscribe', source: 'test', created_at: new Date().toISOString(), created_by: 'test', metadata: {} });
  await seedAuto(storage, 'opp-b-watch');
  assert.equal((await recordAcquisitionOwnerCommand({ opportunityId: 'opp-b-watch', action: 'watch',
    idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, actor: owner,
    storage })).status, 200);
  await seedAuto(storage, 'opp-b-stale', { criteriaProfileVersion: 'uckele-criteria-v0' });
  await seedAuto(storage, 'opp-b-clean');

  const result = await runAutoPursue({ storage });
  const expected = {
    'opp-b-identity': 'identity_unresolved',
    'opp-b-zero': 'recipient_not_single',
    'opp-b-two': 'recipient_not_single',
    'opp-b-generic': 'generic_mailbox',
    'opp-b-prior': 'prior_outreach',
    'opp-b-suppressed': 'suppressed',
    'opp-b-watch': 'owner_decision_exists',
  };
  for (const [id, reason] of Object.entries(expected)) {
    assert.equal(reasonFor(result, id), reason, id);
    assert.equal((await scoreRow(storage, id)).auto_pursue_blocker, reason, id);
    const projection = await storage.readPursueCimProjection({ opportunityId: id });
    assert.notEqual(projection.decision?.actor, 'automation-auto-pursue', id);
  }
  // Out-of-date criteria never reach the runner (they sit in Your review).
  assert.equal(reasonFor(result, 'opp-b-stale'), undefined);
  assert.equal((await storage.readPursueCimProjection({ opportunityId: 'opp-b-stale' })).decision, null);
  assert.equal(result.commands, 1);
  assert.equal((await storage.readPursueCimProjection({ opportunityId: 'opp-b-clean' })).decision.actor,
    'automation-auto-pursue');
});

test('a deal blocked earlier in the business date is not retried that day', async () => {
  const storage = await readyStorage('off');
  await seedAuto(storage, 'opp-later', { email: 'later.broker@brokerfirm.test' });
  await storage.upsertEmailSuppression({ id: randomUUID(), normalized_email: 'later.broker@brokerfirm.test',
    reason: 'bounce', source: 'test', created_at: new Date().toISOString(), created_by: 'test', metadata: {} });
  const now = new Date();
  assert.equal(reasonFor(await runAutoPursue({ storage, now }), 'opp-later'), 'suppressed');
  await storage.liftEmailSuppression('later.broker@brokerfirm.test', { liftedAt: now.toISOString(),
    liftedBy: owner, liftReason: 'test' });
  await setMode(storage, 'canary');
  const later = await runAutoPursue({ storage, now });
  assert.equal(reasonFor(later, 'opp-later'), 'blocked_earlier_today');
  assert.equal(later.commands, 0);
  assert.equal((await scoreRow(storage, 'opp-later')).auto_pursue_blocker ?? null, null);
  const tomorrow = await runAutoPursue({ storage, now: new Date(now.getTime() + 86_400_000) });
  assert.equal(tomorrow.commands, 1);
});

test('owner Pursue during the run is reported as owner_decision_exists', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-race');
  // The owner clicks Request SIM after the runner evaluated the deal but before it records.
  const original = storage.readPursueCimProjection;
  let ownerResult;
  let reads = 0;
  storage.readPursueCimProjection = async (command) => {
    const projection = await original.call(storage, command);
    reads += 1;
    if (reads === 1) {
      ownerResult = await recordAcquisitionOwnerCommand({ opportunityId: 'opp-race', action: 'pursue',
        idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0, expectedMaterialRevision: 0,
        actor: owner, storage });
    }
    return projection;
  };
  let result;
  try {
    result = await runAutoPursue({ storage });
  } finally {
    storage.readPursueCimProjection = original;
  }
  assert.equal(ownerResult.ok, true);
  assert.equal(result.ok, true);
  assert.equal(result.commands, 0);
  assert.equal(reasonFor(result, 'opp-race'), 'owner_decision_exists');
  assert.equal(await autoDecisions(storage), 0);
  const projection = await storage.readPursueCimProjection({ opportunityId: 'opp-race' });
  assert.equal(projection.decision.actor, owner);
});

test('owner Pursue after the runner leaves exactly one decision and neither path errors', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-race-late');
  assert.equal((await runAutoPursue({ storage })).commands, 1);
  const ownerResult = await recordAcquisitionOwnerCommand({ opportunityId: 'opp-race-late', action: 'pursue',
    idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, actor: owner, storage });
  assert.equal(ownerResult.ok, true);
  const projection = await storage.readPursueCimProjection({ opportunityId: 'opp-race-late' });
  assert.equal(projection.decision.actor, 'automation-auto-pursue');
});

test('an owner Pass that wins the race is reported as owner_decision_exists, not an error', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-race-pass');
  const original = storage.readPursueCimProjection;
  let reads = 0;
  storage.readPursueCimProjection = async (command) => {
    const projection = await original.call(storage, command);
    reads += 1;
    if (reads === 1) {
      assert.equal((await recordAcquisitionOwnerCommand({ opportunityId: 'opp-race-pass', action: 'pass',
        reason: 'not-a-fit', idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0,
        expectedMaterialRevision: 0, actor: owner, storage })).status, 200);
    }
    return projection;
  };
  let result;
  try {
    result = await runAutoPursue({ storage });
  } finally {
    storage.readPursueCimProjection = original;
  }
  assert.equal(result.ok, true);
  assert.equal(reasonFor(result, 'opp-race-pass'), 'owner_decision_exists');
  assert.equal(await autoDecisions(storage), 0);
});

async function runWithOwnerActionAtRead(storage, readNumber, ownerAction) {
  const original = storage.readPursueCimProjection;
  let reads = 0;
  let ownerResult;
  storage.readPursueCimProjection = async (command) => {
    const projection = await original.call(storage, command);
    reads += 1;
    if (reads === readNumber) ownerResult = await ownerAction();
    return projection;
  };
  try {
    return { result: await runAutoPursue({ storage }), ownerResult: () => ownerResult };
  } finally {
    storage.readPursueCimProjection = original;
  }
}

test('owner Pursue landing between the final re-check and the command: neither errors, one live enrollment', async () => {
  // Residual window (documented): the locked owner-decision writer treats a Pursue carrying a
  // recipient reference over a queued/waiting Pursue without one as a recipient retry, so the
  // runner's command supersedes the owner's enrollment for the same single recipient.
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-race-window');
  await storage.appendOpportunityTimezoneRevision({ opportunityId: 'opp-race-window',
    expectedPriorRevision: 0, idempotencyKey: 'race-window-timezone', state: 'verified',
    ianaTimezone: 'America/Phoenix', evidenceType: 'operator-verified', evidenceId: 'race-window-evidence',
    evidenceDigest: 'a'.repeat(64), resolverVersion: 'explicit-v1', datasetDigest: 'b'.repeat(64),
    actor: owner, now: new Date().toISOString() });
  // Read 1 is the blocker evaluation; read 2 is the re-check just before recording.
  const { result, ownerResult } = await runWithOwnerActionAtRead(storage, 2, () => recordAcquisitionOwnerCommand({
    opportunityId: 'opp-race-window', action: 'pursue', idempotencyKey: randomUUID(),
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, actor: owner, storage }));
  assert.equal(ownerResult().ok, true);
  assert.equal(result.ok, true);
  assert.ok(result.commands <= 1);
  assert.ok(await autoDecisions(storage) <= 1);
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tempDir, `run-${storageCount}.sqlite`), { readonly: true });
  try {
    const live = raw.prepare(`SELECT COUNT(*) AS count FROM deal_hunter_pursuit_enrollments
      WHERE opportunity_id = ? AND state <> 'superseded'`).get('opp-race-window').count;
    assert.equal(live, 1);
  } finally {
    raw.close();
  }
});

test('owner Pass landing between the final re-check and the command maps the 409 to owner_decision_exists', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-race-window-pass');
  const { result, ownerResult } = await runWithOwnerActionAtRead(storage, 2, () => recordAcquisitionOwnerCommand({
    opportunityId: 'opp-race-window-pass', action: 'pass', reason: 'not-a-fit', idempotencyKey: randomUUID(),
    expectedDiscoveryRevision: 0, expectedMaterialRevision: 0, actor: owner, storage }));
  assert.equal(ownerResult().status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.commands, 0);
  assert.equal(reasonFor(result, 'opp-race-window-pass'), 'owner_decision_exists');
  assert.equal(await autoDecisions(storage), 0);
});

test('canary is refused until warm-up is ready', async () => {
  const storage = freshStorage();
  const rest = { actor: owner, reason: 'test', storage };
  const canary = await setAutoPursueMode({ mode: 'canary', confirmation: 'ACTIVATE AUTO PURSUE CANARY', ...rest });
  assert.equal(canary.status, 409);
  assert.equal(canary.ok, false);
  const active = await setAutoPursueMode({ mode: 'active', confirmation: 'ACTIVATE AUTO PURSUE ACTIVE', ...rest });
  assert.equal(active.status, 409);
  assert.equal((await setAutoPursueMode({ mode: 'shadow', confirmation: 'ACTIVATE AUTO PURSUE SHADOW', ...rest })).status, 200);
  assert.equal((await storage.getCurrentAutoPursueActivation()).mode, 'shadow');
});

test('the runner records nothing in canary when warm-up has since fallen below the gate', async () => {
  const storage = await readyStorage('canary');
  await seedAuto(storage, 'opp-warmup-fell');
  await seedWarmup(storage, { auto: 0, autoChanged: 0 });
  for (let index = 0; index < 5; index += 1) {
    await storage.insertAutoPursueDecisionEvidence({ decision_event_id: `fell-${index}`,
      opportunity_id: `fell-opp-${index}`, action: 'pursue', policy_version: 'owner-decision-v1',
      criteria_group: 'auto', criteria_profile_version: 'uckele-criteria-v1', recipient_unchanged: false,
      created_at: new Date(Date.UTC(2026, 9, 2, 0, 0, index)).toISOString() });
  }
  const result = await runAutoPursue({ storage });
  assert.equal(result.commands, 0);
  assert.equal(result.reason, 'warmup_not_ready');
  assert.equal(reasonFor(result, 'opp-warmup-fell'), 'warmup_not_ready');
});

test('warm-up thresholds', async () => {
  const rows = [];
  const add = (opportunityId, criteriaGroup, action, unchanged, createdAt = '2026-10-01T00:00:00.000Z') => {
    rows.push({ decision_event_id: `e-${rows.length}`, opportunity_id: opportunityId, action,
      criteria_group: criteriaGroup, recipient_unchanged: unchanged ? 1 : 0, created_at: createdAt });
  };
  for (let i = 0; i < 14; i += 1) add(`r-${i}`, 'review', 'pass', true);
  for (let i = 0; i < 10; i += 1) add(`a-${i}`, 'auto', 'pursue', true);
  assert.deepEqual(summarizeAutoPursueWarmup(rows),
    { totalDecisions: 24, autoDecisions: 10, autoUnchangedRate: 1, ready: false });
  // 25 with 9 auto -> not ready
  const nineAuto = rows.filter((row) => row.opportunity_id !== 'a-9');
  nineAuto.push({ ...rows[0], decision_event_id: 'x', opportunity_id: 'r-extra-1' });
  nineAuto.push({ ...rows[0], decision_event_id: 'y', opportunity_id: 'r-extra-2' });
  assert.equal(summarizeAutoPursueWarmup(nineAuto).totalDecisions, 25);
  assert.equal(summarizeAutoPursueWarmup(nineAuto).autoDecisions, 9);
  assert.equal(summarizeAutoPursueWarmup(nineAuto).ready, false);
  // 25 with 10 auto and 1 recipient change (90%) -> not ready
  const changed = [...rows, { ...rows[0], decision_event_id: 'z', opportunity_id: 'r-extra-3' }];
  changed.find((row) => row.opportunity_id === 'a-0').recipient_unchanged = 0;
  assert.deepEqual(summarizeAutoPursueWarmup(changed),
    { totalDecisions: 25, autoDecisions: 10, autoUnchangedRate: 0.9, ready: false });
  // 20/20 unchanged with 25 total -> ready
  const ready = [];
  for (let i = 0; i < 5; i += 1) ready.push({ ...rows[0], decision_event_id: `p-${i}`, opportunity_id: `p-${i}` });
  for (let i = 0; i < 20; i += 1) {
    ready.push({ decision_event_id: `q-${i}`, opportunity_id: `q-${i}`, action: 'pursue', criteria_group: 'auto',
      recipient_unchanged: 1, created_at: '2026-10-01T00:00:00.000Z' });
  }
  assert.deepEqual(summarizeAutoPursueWarmup(ready),
    { totalDecisions: 25, autoDecisions: 20, autoUnchangedRate: 1, ready: true });
  // An auto Pass counts against the rate.
  const withPass = [...ready, { decision_event_id: 'pass-auto', opportunity_id: 'pass-auto', action: 'pass',
    criteria_group: 'auto', recipient_unchanged: 1, created_at: '2026-10-01T00:00:00.000Z' }];
  assert.equal(summarizeAutoPursueWarmup(withPass).autoUnchangedRate, 20 / 21);
  assert.equal(summarizeAutoPursueWarmup(withPass).ready, true);
});

test('warm-up counts each opportunity once by its latest evidence row', async () => {
  const rows = [
    { decision_event_id: 'b', opportunity_id: 'o1', action: 'pursue', criteria_group: 'auto',
      recipient_unchanged: 0, created_at: '2026-10-01T00:00:00.000Z' },
    { decision_event_id: 'a', opportunity_id: 'o1', action: 'pursue', criteria_group: 'auto',
      recipient_unchanged: 1, created_at: '2026-10-02T00:00:00.000Z' },
    { decision_event_id: 'c', opportunity_id: 'o2', action: 'pursue', criteria_group: 'auto',
      recipient_unchanged: 1, created_at: '2026-10-03T00:00:00.000Z' },
    { decision_event_id: 'd', opportunity_id: 'o2', action: 'pursue', criteria_group: 'auto',
      recipient_unchanged: 0, created_at: '2026-10-03T00:00:00.000Z' },
  ];
  assert.deepEqual(summarizeAutoPursueWarmup(rows),
    { totalDecisions: 2, autoDecisions: 2, autoUnchangedRate: 0.5, ready: false });
  const storage = freshStorage();
  await seedWarmup(storage, { auto: 20, other: 5 });
  const warmup = await getAutoPursueWarmup({ storage });
  assert.equal(warmup.ready, true);
  assert.equal(warmup.totalDecisions, 25);
  const fake = { listAutoPursueDecisionEvidence: async ({ policyVersion }) => {
    assert.equal(policyVersion, 'owner-decision-v1');
    return rows;
  } };
  assert.equal((await getAutoPursueWarmup({ storage: fake })).totalDecisions, 2);
});

test('wrong confirmation is rejected', async () => {
  const storage = await readyStorage();
  for (const [mode, confirmation] of [['off', 'set auto pursue off'], ['shadow', 'ACTIVATE AUTO PURSUE CANARY'],
    ['canary', ''], ['active', undefined], ['active', 'ACTIVATE AUTO PURSUE ACTIVE ']]) {
    const result = await setAutoPursueMode({ mode, confirmation, actor: owner, storage });
    assert.equal(result.status, 400, `${mode} ${confirmation}`);
  }
  assert.equal((await setAutoPursueMode({ mode: 'on', confirmation: 'ACTIVATE AUTO PURSUE ACTIVE', actor: owner,
    storage })).status, 400);
  assert.equal((await setAutoPursueMode({ mode: 'shadow', confirmation: 'ACTIVATE AUTO PURSUE SHADOW', actor: '',
    storage })).status, 400);
  assert.equal(await storage.getCurrentAutoPursueActivation(), null);
});

test('activation, run history, or warm-up storage failure records zero commands', async () => {
  const storage = await readyStorage('active', { dailyCap: 3 });
  await seedAuto(storage, 'opp-storage-down');
  const original = storage.getCurrentAutoPursueActivation;
  storage.getCurrentAutoPursueActivation = async () => { throw new Error('down'); };
  try {
    const result = await runAutoPursue({ storage });
    assert.equal(result.ok, false);
    assert.equal(result.commands, 0);
    assert.equal(result.reason, 'runner_storage_unavailable');
  } finally {
    storage.getCurrentAutoPursueActivation = original;
  }
  const evidence = storage.listAutoPursueDecisionEvidence;
  storage.listAutoPursueDecisionEvidence = async () => { throw new Error('down'); };
  try {
    const result = await runAutoPursue({ storage, now: new Date(Date.now() + 1000) });
    assert.equal(result.commands, 0);
    assert.equal(result.reason, 'warmup_unavailable');
  } finally {
    storage.listAutoPursueDecisionEvidence = evidence;
  }
  const count = storage.countOwnerDecisionsByPolicy;
  storage.countOwnerDecisionsByPolicy = async () => { throw new Error('down'); };
  try {
    const result = await runAutoPursue({ storage, now: new Date(Date.now() + 2000) });
    assert.equal(result.commands, 0);
    assert.equal(result.reason, 'decision_count_unavailable');
  } finally {
    storage.countOwnerDecisionsByPolicy = count;
  }
  assert.equal(await autoDecisions(storage), 0);
});

test('turning the capability off mid-run stops before the next command', async () => {
  const storage = await readyStorage('active', { dailyCap: 5 });
  await seedAuto(storage, 'opp-stop-1');
  await seedAuto(storage, 'opp-stop-2');
  const original = storage.countOwnerDecisionsByPolicy;
  let counts = 0;
  storage.countOwnerDecisionsByPolicy = async (input) => {
    counts += 1;
    if (counts === 2) await setMode(storage, 'off');
    return original.call(storage, input);
  };
  let result;
  try {
    result = await runAutoPursue({ storage });
  } finally {
    storage.countOwnerDecisionsByPolicy = original;
  }
  assert.equal(result.commands, 1);
  assert.equal(result.reason, 'mode_changed');
  assert.equal(await autoDecisions(storage), 1);
});

test('runner never calls the delivery provider', async () => {
  const storage = await readyStorage('active', { dailyCap: 5 });
  await seedAuto(storage, 'opp-provider-1');
  await seedAuto(storage, 'opp-provider-2');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(`fetch ${url}`); throw new Error('provider must not be called'); };
  const providerMethods = ['enterCimProviderSeam', 'authorizeCimProviderPending', 'issueCimLiveProviderAuthorization',
    'prepareCimTransmission', 'finalizeCimTransmission', 'reconcileCimTransmission', 'claimDealHunterCimRequest',
    'claimDealHunterCimRecipient'];
  const originals = Object.fromEntries(providerMethods.map((name) => [name, storage[name]]));
  for (const name of providerMethods) {
    storage[name] = async () => { calls.push(name); throw new Error(`${name} must not be called`); };
  }
  let result;
  try {
    result = await runAutoPursue({ storage });
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(storage, originals);
  }
  assert.equal(result.commands, 2);
  assert.deepEqual(calls, []);
  const source = fs.readFileSync(new URL('../server/services/autoPursue.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '\.\/(delivery|cimProvider|pursueCimProvider|email)[^']*'/);
  assert.doesNotMatch(source, /\bfetch\(/);
});

test('Supabase adapter: authoritative count, exclusive claim, activation RPC, and blocker RPC shapes', async () => {
  const { createSupabaseStorage } = await import('../server/storage/supabase.js');
  const calls = [];
  const responses = [];
  const builder = (table) => {
    const chain = { table, steps: [] };
    const proxy = new Proxy(chain, {
      get(target, property) {
        if (property === 'then') {
          const response = responses.shift() || { data: null, error: null };
          calls.push({ table, steps: target.steps });
          return (resolve) => resolve(response);
        }
        return (...args) => { target.steps.push([property, ...args]); return proxy; };
      },
    });
    return proxy;
  };
  const rpcCalls = [];
  const storage = createSupabaseStorage({ storage: { supabaseUrl: '', supabaseServiceRoleKey: '' } }, {
    client: {
      from: builder,
      async rpc(name, parameters) {
        rpcCalls.push({ name, parameters });
        return name === 'set_deal_hunter_auto_pursue_blockers_v1' ? { data: 2, error: null }
          : { data: { id: parameters.p_activation.id, status: 'current', mode: parameters.p_activation.mode }, error: null };
      },
    },
  });
  responses.push({ count: 4, error: null });
  assert.equal(await storage.countOwnerDecisionsByPolicy({ policyVersion: 'auto-pursue-v1',
    since: '2026-11-02T08:00:00.000Z', until: '2026-11-03T08:00:00.000Z' }), 4);
  assert.deepEqual(calls.at(-1), { table: 'deal_hunter_owner_decision_events', steps: [
    ['select', 'id', { count: 'exact', head: true }], ['eq', 'policy_version', 'auto-pursue-v1'],
    ['gte', 'created_at', '2026-11-02T08:00:00.000Z'], ['lt', 'created_at', '2026-11-03T08:00:00.000Z']] });
  responses.push({ count: null, error: null });
  await assert.rejects(storage.countOwnerDecisionsByPolicy({ policyVersion: 'auto-pursue-v1',
    since: '2026-11-02T08:00:00.000Z', until: '2026-11-03T08:00:00.000Z' }));

  responses.push({ data: null, error: { code: '23505', message: 'duplicate key value' } });
  responses.push({ data: { id: 'existing', run_key: 'k', completed_at: null }, error: null });
  const claim = await storage.claimAutoPursueRun({ id: 'new', run_key: 'k', business_date: '2026-11-02',
    mode: 'canary', created_at: '2026-11-02T18:00:00.000Z' });
  assert.deepEqual(claim, { claimed: false, run: { id: 'existing', run_key: 'k', completed_at: null } });
  responses.push({ data: null, error: { code: '42501', message: 'permission denied' } });
  await assert.rejects(storage.claimAutoPursueRun({ id: 'new2', run_key: 'k2' }), { code: '42501' });

  const activation = await storage.createAutoPursueActivation({ id: 'act', mode: 'off', daily_cap: 0,
    actor: owner, reason: '', confirmation: 'SET AUTO PURSUE OFF', created_at: '2026-11-02T18:00:00.000Z' });
  assert.equal(activation.status, 'current');
  assert.equal(rpcCalls.at(-1).name, 'create_deal_hunter_auto_pursue_activation_v1');
  assert.equal(await storage.setDealHunterAutoPursueBlockers([{ opportunityId: 'o1', blocker: 'suppressed',
    checkedAt: '2026-11-02T18:00:00.000Z' }, { opportunityId: 'o2', blocker: '', checkedAt: '2026-11-02T18:00:00.000Z' }]), 2);
  assert.deepEqual(rpcCalls.at(-1), { name: 'set_deal_hunter_auto_pursue_blockers_v1', parameters: { p_entries: [
    { opportunity_id: 'o1', blocker: 'suppressed', checked_at: '2026-11-02T18:00:00.000Z' },
    { opportunity_id: 'o2', blocker: null, checked_at: '2026-11-02T18:00:00.000Z' }] } });
});
