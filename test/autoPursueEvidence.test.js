import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-auto-pursue-evidence-'));
process.env.ADMIN_SESSION_SECRET = 'auto-pursue-evidence-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'auto-pursue-evidence-document-secret';
process.env.SQLITE_PATH = path.join(tempDir, 'evidence.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'source-health.json');
process.env.DEAL_HUNTER_AIRTABLE_ENABLED = 'false';
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const checkedAt = new Date().toISOString();
fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify({
  generatedAt: checkedAt,
  issues: [],
  totals: { reviewedDeals: 1 },
  sources: {
    'sheet-0': { rowCount: 1, name: 'SMB Deal Hunter Google Sheet', mode: 'csv', required: true,
      sourceRole: 'required-primary', checkedAt },
    'deal-os-export': { rowCount: 1, name: 'SMB Deal OS export', mode: 'manual-export',
      required: false, sourceRole: 'optional-supplemental', checkedAt, exportedAt: checkedAt,
      maxAgeHours: 72 },
  },
}));

const { getStorage } = await import('../server/storage/index.js');
const { recordAcquisitionOwnerCommand } = await import('../server/services/dealHunterTriage.js');
const { loadBrokerMaterialsAuthority } = await import('../server/services/dealHunterBrokerMaterials.js');
const { setCurrentOperatorOpportunityFact } = await import('../server/services/dealHunterOpportunityFacts.js');

const storage = getStorage();

async function seed(opportunityId, { criteriaGroup = 'auto' } = {}) {
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: '2026-08-30T09:00:00.000Z',
    updated_at: '2026-08-30T09:00:00.000Z', canonical_name: 'Evidence Opportunity',
    canonical_recipient: null, canonical_location: 'Dallas, TX', primary_submission_id: null,
    identity_version: 'auto-pursue-evidence', status: 'active', metadata: {},
  });
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: opportunityId, scored_at: '2026-08-30T10:00:00.000Z',
    deal_key: `deal-${opportunityId}`, name: 'Evidence Opportunity', state: 'TX',
    listing_url: `https://broker.example/${opportunityId}`, fit_score: 82, score_status: 'watchlist',
    confidence: 'medium', completeness_score: 70, contradiction_count: 0, missing_evidence_count: 1,
    should_remove: false, high_fit: false, gate_count: 0, score_fingerprint: 'evidence-fingerprint',
    semantic_digest: 'evidence-digest', engine_version: 'evidence-test', rules_version: 'evidence-test',
    profile_version: 'evidence-test', completeness_policy_version: 'evidence-test', dimensions: [],
    gates: [], applied_caps: [], missing_evidence: [], confidence_reasons: [], summary: {},
    criteria_profile_version: 'uckele-criteria-v1', criteria_group: criteriaGroup,
    criteria_result: { mustHaves: [], failed: [], unknown: [] },
  });
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
  return opportunityId;
}

const command = (opportunityId, action, extra = {}) => ({
  opportunityId, action, idempotencyKey: randomUUID(), expectedDiscoveryRevision: 0,
  expectedMaterialRevision: 0, actor: 'owner', ...extra,
});

const evidenceFor = async (opportunityId, policyVersion = 'owner-decision-v1') =>
  (await storage.listAutoPursueDecisionEvidence({ policyVersion }))
    .filter((row) => row.opportunity_id === opportunityId);

test('unknown decision policy version is rejected', async () => {
  const id = await seed('opp-evidence-bad-policy');
  const result = await recordAcquisitionOwnerCommand({ ...command(id, 'pursue'), decisionPolicyVersion: 'x' });
  assert.equal(result.status, 400);
  assert.equal(result.ok, false);
  assert.equal((await evidenceFor(id)).length, 0);
});

test('pursue writes warm-up evidence with the criteria group', async () => {
  const id = await seed('opp-evidence-pursue');
  const result = await recordAcquisitionOwnerCommand(command(id, 'pursue'));
  assert.equal(result.status, 200);
  const rows = await evidenceFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].criteria_group, 'auto');
  assert.equal(rows[0].criteria_profile_version, 'uckele-criteria-v1');
  assert.equal(rows[0].action, 'pursue');
  assert.equal(rows[0].policy_version, 'owner-decision-v1');
});

test('a no-ref pursue whose enrollment ends action-required records recipient_unchanged 0', async () => {
  // No recipient authority exists for this opportunity, so the recipient is never resolved.
  const id = await seed('opp-evidence-action-required');
  const result = await recordAcquisitionOwnerCommand(command(id, 'pursue'));
  assert.equal(result.status, 200);
  assert.equal(result.enrollment.state, 'action-required');
  const [row] = await evidenceFor(id);
  assert.equal(row.recipient_unchanged, 0);
});

test('a supplied ref resolving to the single recipient option records recipient_unchanged 1', async () => {
  const id = await seed('opp-evidence-resolved-ref');
  await setCurrentOperatorOpportunityFact({ opportunityId: id, field: 'broker_email',
    value: 'broker@example.test', actor: 'owner', verified: true, idempotencyKey: randomUUID(),
    expectedRevision: { campaignAuthorityRevision: 1, primarySubmissionId: null,
      submissionFactSnapshot: null },
    storage });
  const authority = await loadBrokerMaterialsAuthority({ opportunityId: id, storage });
  assert.equal(authority.recipientOptions.length, 1);
  // Full enrollment orchestration needs complete source, timezone and permission authority,
  // which this fixture does not build. Without a transition writer the enrollment is left as
  // the decision created it (not action-required), so this isolates the recipient comparison.
  const transition = storage.transitionPursuitEnrollment;
  storage.transitionPursuitEnrollment = undefined;
  let result;
  try {
    result = await recordAcquisitionOwnerCommand(command(id, 'pursue',
      { recipientContactRef: authority.recipientOptions[0].recipientContactRef }));
  } finally {
    storage.transitionPursuitEnrollment = transition;
  }
  assert.equal(result.status, 200);
  assert.notEqual(result.enrollment.state, 'action-required');
  const [row] = await evidenceFor(id);
  assert.equal(row.recipient_unchanged, 1);
});

test('pass writes warm-up evidence with the criteria group', async () => {
  const id = await seed('opp-evidence-pass', { criteriaGroup: 'review' });
  const result = await recordAcquisitionOwnerCommand(command(id, 'pass', { reason: 'not-a-fit' }));
  assert.equal(result.status, 200);
  const rows = await evidenceFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'pass');
  assert.equal(rows[0].criteria_group, 'review');
  assert.equal(rows[0].recipient_unchanged, 1);
});

test('auto-pursue-v1 is recorded as the decision and evidence policy', async () => {
  const id = await seed('opp-evidence-auto-policy');
  const result = await recordAcquisitionOwnerCommand({ ...command(id, 'pursue', { actor: 'automation-auto-pursue' }),
    decisionPolicyVersion: 'auto-pursue-v1',
    autoPursueGuard: { since: new Date(Date.now() - 3_600_000).toISOString(),
      until: new Date(Date.now() + 3_600_000).toISOString(), dailyCap: 1 } });
  assert.equal(result.status, 200);
  assert.equal((await evidenceFor(id, 'auto-pursue-v1')).length, 1);
  assert.equal((await evidenceFor(id)).length, 0);
});

test('replayed command writes no second evidence row', async () => {
  const id = await seed('opp-evidence-replay');
  const input = command(id, 'pursue');
  assert.equal((await recordAcquisitionOwnerCommand(input)).replay, false);
  assert.equal((await recordAcquisitionOwnerCommand(input)).replay, true);
  assert.equal((await evidenceFor(id)).length, 1);
});

test('watch writes no evidence', async () => {
  const id = await seed('opp-evidence-watch');
  assert.equal((await recordAcquisitionOwnerCommand(command(id, 'watch'))).status, 200);
  assert.equal((await evidenceFor(id)).length, 0);
});

test('an unresolvable recipient reference records recipient_unchanged false', async () => {
  const id = await seed('opp-evidence-recipient');
  const result = await recordAcquisitionOwnerCommand(command(id, 'pursue',
    { recipientContactRef: 'opaque-selected-contact-v1' }));
  assert.equal(result.status, 200);
  const [row] = await evidenceFor(id);
  assert.equal(row.recipient_unchanged, 0);
});

test('a failed evidence write is logged and never fails the owner command', async () => {
  const id = await seed('opp-evidence-failure');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const original = storage.insertAutoPursueDecisionEvidence;
  storage.insertAutoPursueDecisionEvidence = async () => { throw new Error('evidence store down'); };
  try {
    const result = await recordAcquisitionOwnerCommand(command(id, 'pursue'));
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
  } finally {
    console.warn = originalWarn;
    storage.insertAutoPursueDecisionEvidence = original;
  }
  assert.ok(warnings.some((line) => line.startsWith('[auto-pursue:evidence]')), warnings.join('\n'));
});
