import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { calculateCampaignExpiry } from '../server/services/cimCampaignPolicy.js';
import { CONTACT_POLICY_VERSION, contactPolicyDigest } from '../server/services/pursueCimContactPolicy.js';
import { authorizePreparedCimTransmission } from '../server/services/pursueCimFinalGate.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';
const GMAIL_PROFILE = 'production-gmail-v1';
const SENDER = 'owner@uckele.example.test';
const BROKER = 'broker@example.test';
const seededAt = '2026-09-25T19:00:00.000Z';
// Tuesday 2026-09-29 09:00 in Los Angeles: inside the send window.
const GATE_NOW = '2026-09-29T16:00:00.000Z';
const fill = (character) => character.repeat(64);

function uuidFor(value) {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input,
    maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(container, database, sql) {
  return run(dockerCommand, ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', database], sql).trim();
}

/** A Supabase client stand-in that runs the adapter's RPCs and reads as service_role. */
function serviceRoleClient(container, database) {
  const sql = (statement) => psql(container, database, `set role service_role; ${statement}`);
  const literal = (value) => `$json$${JSON.stringify(value)}$json$::jsonb`;
  return {
    async rpc(name, args) {
      try {
        const call = args === undefined ? `public.${name}()`
          : Object.hasOwn(args, 'p_command') ? `public.${name}(${literal(args.p_command)})`
            : `public.${name}(${Object.values(args).map((value) => (typeof value === 'number'
              ? String(value) : `'${value}'`)).join(', ')})`;
        const output = sql(`select coalesce(to_jsonb(${call})::text, 'null');`);
        return { data: JSON.parse(output), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from(table) {
      const select = async () => ({ data: JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t)),
        '[]'::jsonb)::text from public.${table} t;`)), error: null });
      const builder = { select() { return builder; },
        then(resolve, reject) { return select().then(resolve, reject); } };
      return builder;
    },
  };
}

function seedCampaign(container, database, suffix, recipientFingerprint, { followUp, basis }) {
  const opportunityId = `opp-gmail-${suffix}`;
  const submissionId = uuidFor(`submission-${suffix}`);
  const ids = { opportunityId, campaignId: `campaign-${suffix}`, touchId: `touch-${suffix}`,
    conversationId: `conversation-${suffix}`, submissionId };
  const realNow = new Date().toISOString();
  const initialAcceptedAt = new Date(Date.parse(realNow) - 24 * 60 * 60 * 1000).toISOString();
  const derivation = calculateCampaignExpiry(initialAcceptedAt, 'America/Los_Angeles', '08:00');
  const [permissionVersion, permissionDigest] = basis === 'rule'
    ? [CONTACT_POLICY_VERSION, contactPolicyDigest()] : ['gmail-fl04b-enrollment', fill('2')];
  psql(container, database, `
    insert into public.deal_hunter_opportunities (opportunity_id, created_at, updated_at,
      canonical_name, identity_version, discovery_state)
      values ('${opportunityId}', '${seededAt}', '${seededAt}', 'Acme Plumbing', 'cim-identity-v1',
        'known_prospective');
    insert into public.deal_hunter_owner_decision_events (id, idempotency_key, request_digest,
      opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at)
      values ('decision-${suffix}', 'idem-${suffix}', '${fill('a')}', '${opportunityId}', 'pursue',
        'fixture-owner', 0, 0, 0, 0, 'owner-decision-v1', '${seededAt}');
    insert into public.deal_hunter_pursuit_enrollments (id, decision_event_id, opportunity_id,
      state, authority_digest, created_at, updated_at, row_version)
      values ('enrollment-${suffix}', 'decision-${suffix}', '${opportunityId}', 'campaign-created',
        '${fill('b')}', '${seededAt}', '${seededAt}', 2);
    insert into public.deal_hunter_opportunity_timezone_revisions (opportunity_id, revision, state,
      iana_timezone, evidence_type, evidence_id, evidence_digest, resolver_version, dataset_digest,
      actor, created_at)
      values ('${opportunityId}', 1, 'verified', 'America/Los_Angeles', 'operator-verified',
        'timezone-evidence', '${fill('c')}', 'explicit-v1', '${fill('d')}', 'fixture-owner',
        '${seededAt}');
    insert into public.deal_hunter_broker_conversations (id, recipient_authority_id,
      recipient_fingerprint, recipient_address, sender_policy_version, reply_policy_version,
      reply_alias_token_digest, rfc_thread_key, state, terminal_revision, batching_policy_version,
      created_at, updated_at, row_version, gmail_thread_id)
      values ('${ids.conversationId}', 'recipient-authority', '${recipientFingerprint}', '${BROKER}',
        'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', '${sha256(`alias-${suffix}`)}',
        'thread-${suffix}', 'open', 0, 'batching-off-v1', '${seededAt}', '${seededAt}', 1,
        ${followUp ? `'gmail-thread-${suffix}'` : 'null'});
    insert into public.contact_submissions (id, created_at, updated_at, status, delivery_provider,
      delivery_status, crm_status, source, ip_hash, name, email, message, deal_hunter_opportunity_id)
      values ('${submissionId}', '${seededAt}', '${seededAt}', 'open', 'none', 'not-attempted',
        'active', 'synthetic', 'synthetic-ip', 'Synthetic broker', '${BROKER}', 'Synthetic owner',
        '${opportunityId}');
    update public.deal_hunter_opportunities set primary_submission_id = '${submissionId}'
      where opportunity_id = '${opportunityId}';
    insert into public.deal_hunter_cim_campaigns (id, opportunity_id, generation, enrollment_id,
      decision_event_id, policy_version, template_version, template_digest, permission_version,
      permission_digest, permission_revision, permission_scope, canonical_revision,
      crm_submission_id, crm_ownership_revision, recipient_authority_id, recipient_fingerprint,
      freshness_authority_digest, discovery_revision, material_revision, timezone_revision,
      conversation_id, state, reason_code, terminal_revision, row_version, created_at, updated_at,
      initial_accepted_at, local_expiry_at, expiry_derivation)
      values ('${ids.campaignId}', '${opportunityId}', 1, 'enrollment-${suffix}', 'decision-${suffix}',
        'deal-hunter-cim-autopilot-v1', 'deal-hunter-cim-autopilot-v1', '${fill('1')}',
        '${permissionVersion}', '${permissionDigest}', 1, '${fill('f')}', 1, '${submissionId}',
        (select coalesce(max(revision), 1) from public.deal_hunter_crm_ownership_revisions
          where opportunity_id = '${opportunityId}'), 'recipient-authority',
        '${recipientFingerprint}', '${fill('3')}', 0, 0, 1, '${ids.conversationId}',
        '${followUp ? 'active-follow-up' : 'initial-pending'}', ${followUp ? 'null' : "'awaiting-window'"},
        0, 1, '${seededAt}', '${seededAt}',
        ${followUp ? `'${initialAcceptedAt}', '${derivation.expiresAt}', $json$${stableCanonicalJson(derivation)}$json$::jsonb`
    : 'null, null, \'{}\'::jsonb'});
    insert into public.deal_hunter_cim_campaign_touches (id, campaign_id, opportunity_id,
      logical_slot, kind, ordinal, due_at, due_local, timezone_revision, state, row_version,
      created_at, updated_at)
      values ('${ids.touchId}', '${ids.campaignId}', '${opportunityId}',
        '${followUp ? 'follow-up-1' : 'initial'}', '${followUp ? 'follow-up-1' : 'initial'}',
        ${followUp ? 1 : 0}, '2026-09-29T15:00:00.000Z', '2026-09-29T08:00:00-07:00', 1,
        'scheduled', 1, '${seededAt}', '${seededAt}');
    insert into public.deal_hunter_opportunity_source_observations (id, opportunity_id, source_id,
      source_name, source_record_id, field, value, observed_at, accepted_at, accepted_run_id,
      created_at, updated_at)
      values ('source-row-${suffix}', '${opportunityId}', 'sheet-0', 'Synthetic Sheet',
        'source-record-${suffix}', 'broker_email', '${BROKER}', '${seededAt}', '${seededAt}',
        'source-run', '${seededAt}', '${seededAt}');
  `);
  return ids;
}

async function prepareGate({ container, database, storage, suffix, followUp = false,
  basis = 'activation' }) {
  const recipient = { email: BROKER, provenanceFingerprint: fill('9'),
    permissionProvenanceFingerprint: fill('a'), contactAuthorityRevision: fill('b') };
  const opportunityId = `opp-gmail-${suffix}`;
  const recipientFingerprint = sha256(stableCanonicalJson({ opportunityId,
    emailHash: sha256(recipient.email), provenanceFingerprint: recipient.provenanceFingerprint,
    contactAuthorityRevision: recipient.contactAuthorityRevision }));
  const ids = seedCampaign(container, database, suffix, recipientFingerprint, { followUp, basis });
  const realNow = new Date().toISOString();
  const claimTokenDigest = fill('e');
  const claim = await storage.claimDueCimTouch({ touchId: ids.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest, claimOwner: 'gmail-worker',
    claimExpiresAt: new Date(Date.parse(followUp ? realNow : GATE_NOW) + 4 * 60_000).toISOString(),
    now: followUp ? realNow : '2026-09-29T15:30:00.000Z' });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const message = {
    payloadVersion: followUp ? 'deal-hunter-cim-pursue-follow-up-v1'
      : 'deal-hunter-cim-pursue-initial-v2',
    fromAddress: SENDER, toAddresses: [BROKER], ccAddresses: [], bccAddresses: [],
    replyToAddress: SENDER, subject: 'CIM / NDA request for Acme Plumbing',
    bodyText: `Synthetic body ${suffix}`, bodyHtmlSanitized: `<p>Synthetic body ${suffix}</p>`,
    tags: [`cim_touch_id=${ids.touchId}`],
  };
  const prepared = followUp
    ? await storage.prepareReservedCimFollowUp({ activationId: 'gmail-fl04c-followup',
      claimOwner: 'gmail-worker', recipientFingerprint, touchIds: [ids.touchId], claimTokenDigest,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0, ...message,
      preparationGeneration: 1, actor: 'gmail-worker' })
    : await storage.prepareCimTransmission({ touchIds: [ids.touchId], claimTokenDigest,
      expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
      preparationGeneration: 1, ...message, actor: 'gmail-worker', now: '2026-09-29T15:31:00.000Z' });
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
  const capability = followUp ? 'fl04c-followup' : 'fl04b-initial';
  const writerPath = followUp ? 'pursue-cim-follow-up' : 'pursue-cim-initial';
  const issued = await storage.issueCimLiveProviderAuthorization({ id: `authorization-${suffix}`,
    activationId: `gmail-${capability}`, capability, writerPath,
    transmissionId: prepared.transmission.id, payloadDigest: prepared.transmission.payload_digest,
    recipientAuthorityDigest: recipientFingerprint, providerProfile: GMAIL_PROFILE,
    expiresAt: '2026-09-29T17:00:00.000Z', actor: 'fixture-owner', reason: 'gate test',
    now: '2026-09-29T15:45:00.000Z' });
  assert.equal(issued.issued, true, JSON.stringify(issued));
  const read = (sql) => JSON.parse(psql(container, database, sql));
  const gate = (overrides = {}) => authorizePreparedCimTransmission({ storage,
    transmissionId: prepared.transmission.id, authorizationId: `authorization-${suffix}`,
    writerPath, providerProfile: GMAIL_PROFILE, actor: 'fixture-owner', now: GATE_NOW,
    configOverride: { isProduction: false, dealHunter: { cimProvider: { enabled: true,
      profile: GMAIL_PROFILE, mode: 'production-gmail', provider: 'gmail',
      gmailSenderAddress: SENDER } } },
    loadMemberAuthority: async () => ({ opportunityId, recipientOptions: [recipient],
      materialsState: { materialsReceived: false, advancedBeyondBrokerOutreach: false,
        evidenceCodes: [] }, preparationBlockers: [], suppression: null, terminalReason: '',
      existingRequest: null, opportunityClaim: null, currentDispositionState: 'pursued',
      pursued: true }),
    readCurrentAuthority: async () => ({ opportunityId, blocked: false, blockers: [],
      opportunity: read(`select to_jsonb(o)::text from public.deal_hunter_opportunities o
        where opportunity_id = '${opportunityId}';`),
      sourceRows: read(`select jsonb_agg(to_jsonb(s))::text from public.deal_hunter_opportunity_source_observations s
        where opportunity_id = '${opportunityId}';`),
      sourceStates: read(`select jsonb_agg(to_jsonb(s))::text from public.deal_hunter_source_freshness_state s;`),
      sourceHealth: { healthy: true, issues: [], requiredSources: ['sheet-0'] },
      identityExceptions: [] }),
    readProviderReadiness: async ({ now }) => ({ provider: 'gmail', providerProfile: GMAIL_PROFILE,
      ready: true, reasons: [], signatureComplete: true, evidenceRevision: `readiness-${suffix}`,
      generatedAt: now, expiresAt: new Date(Date.parse(now) + 60_000).toISOString() }),
    ...overrides });
  return { ids, transmission: prepared.transmission, capability, writerPath, gate };
}

test('PostgreSQL final gate accepts the contact rule basis and single-member follow-ups, and releases unsent Gmail work', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 240_000,
}, async (t) => {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `uckele-gmail-gate-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  t.after(() => {
    if (started) run(dockerCommand, ['rm', '-f', container]);
  });
  run(dockerCommand, ['run', '--rm', '--pull=never', '--network=none', '--tmpfs', '/var/lib/postgresql/data',
    '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic', '-d', 'postgres:16']);
  started = true;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = spawnSync(dockerCommand, ['logs', container], { encoding: 'utf8' });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`.match(/database system is ready to accept connections/g)?.length || 0;
    const ready = spawnSync(dockerCommand, ['exec', container, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
    if (readyEvents >= 2 && ready.status === 0) break;
    if (attempt === 99) throw new Error('Disposable PostgreSQL did not become ready.');
    Atomics.wait(signal, 0, 0, 100);
  }
  const database = 'gmail_gate';
  psql(container, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create database ${database};
  `);
  psql(container, database, fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8'));
  const storage = createSupabaseStorage({ storage: {} }, { client: serviceRoleClient(container, database) });
  let parentId = null;
  for (const capability of ['fl04a-safety', 'fl04b-enrollment', 'fl04b-initial', 'fl04c-followup']) {
    const id = `gmail-${capability}`;
    const recorded = await storage.recordCimCapabilityActivation({ id, capability, mode: 'active',
      policyHash: fill('a'), configHash: fill('b'), actor: 'fixture-owner',
      reason: 'disposable test authority', confirmation: 'fixture-confirmation',
      providerProfile: GMAIL_PROFILE, now: seededAt,
      ...(capability === 'fl04c-followup' ? { dailyCap: 10, recipientCap: 10 } : {}),
      ...(parentId ? { prerequisiteActivationId: parentId,
        prerequisiteEvidenceId: `evidence-${capability}`, prerequisiteEvidenceHash: fill('c') } : {}) });
    assert.equal(recorded.applied, true, JSON.stringify(recorded));
    parentId = id;
  }
  psql(container, database, `
    update public.deal_hunter_cim_capability_activations set permission_basis_digest = '${fill('2')}',
      permission_revision = 1, cohort_digest = '${fill('f')}' where id = 'gmail-fl04b-initial';
    insert into public.deal_hunter_cim_safety_settings (id, updated_at, outreach_paused, updated_by,
      metadata) values ('global', '${seededAt}', false, 'fixture-owner', '{}'::jsonb)
      on conflict (id) do update set outreach_paused = false;
    insert into public.deal_hunter_source_freshness_state (source_id, next_generation,
      accepted_generation, accepted_run_id, accepted_digest, accepted_at, projection_state)
      values ('sheet-0', 1, 1, 'source-run', '${fill('c')}', '${seededAt}', 'accepted');
  `);
  let ruleRevision = 0;
  const setRule = async (enabled, policyVersion = CONTACT_POLICY_VERSION) => {
    ruleRevision = (await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled,
      policyVersion, expectedRevision: ruleRevision, actor: 'owner', reason: 'gate test',
      now: seededAt })).revision;
  };
  const scalar = (sql) => psql(container, database, sql);
  const terminalEvents = () => Number(scalar('select count(*) from public.deal_hunter_cim_terminal_events;'));
  const campaignState = (id) => scalar(`select state || ':' || terminal_revision
    from public.deal_hunter_cim_campaigns where id = '${id}';`);
  const minute = (offset) => new Date(Date.parse(GATE_NOW) + offset * 60_000).toISOString();

  // The activation basis initial path is unchanged.
  const activation = await prepareGate({ container, database, storage, suffix: 'activation' });
  const activationGate = await activation.gate();
  assert.equal(activationGate.authorized, true, JSON.stringify(activationGate));

  // A rule-based campaign: off pauses without terminal events; on again resumes.
  const rule = await prepareGate({ container, database, storage, suffix: 'rule', basis: 'rule' });
  assert.equal((await rule.gate()).blockedReason, 'contact_rule_off');
  await setRule(true, 'listing-broker-inquiry-v2');
  assert.equal((await rule.gate({ now: minute(1) })).blockedReason, 'contact_rule_off');
  assert.equal(campaignState(rule.ids.campaignId), 'initial-pending:0');
  assert.equal(terminalEvents(), 0);
  await setRule(true);
  const ruleGate = await rule.gate({ now: minute(2) });
  assert.equal(ruleGate.authorized, true, JSON.stringify(ruleGate));

  // Gmail never accepted it: the release returns the touch to scheduled, and it is listed
  // again under the next preparation generation and can be claimed.
  const seam = await storage.enterCimProviderSeam({ transmissionId: rule.transmission.id,
    authorizationId: 'authorization-rule', writerPath: rule.writerPath, providerProfile: GMAIL_PROFILE,
    capability: rule.capability, payloadDigest: rule.transmission.payload_digest,
    boundaryNonceDigest: sha256(ruleGate.boundaryNonce),
    expectedRowVersion: Number(ruleGate.transmission.row_version), actor: 'pursue-cim-sender',
    now: minute(2) });
  assert.equal(seam.entered, true, JSON.stringify(seam));
  const releaseCommand = { transmissionId: rule.transmission.id,
    payloadDigest: rule.transmission.payload_digest,
    expectedRowVersion: Number(ruleGate.transmission.row_version) + 1, provider: 'gmail',
    providerResultCode: 'provider_quota', actor: 'pursue-cim-sender', now: minute(3) };
  const released = await storage.releaseCimProviderPendingUnsent(releaseCommand);
  assert.equal(released.applied, true, JSON.stringify(released));
  assert.equal(released.transmission.state, 'cancelled-before-provider');
  assert.equal(released.transmission.provider_result_code, 'provider_quota');
  assert.deepEqual(released.touches.map((touch) => [touch.id, touch.state, touch.transmission_id]),
    [[rule.ids.touchId, 'scheduled', null]]);
  assert.equal((await storage.releaseCimProviderPendingUnsent(releaseCommand)).replay, true);
  assert.equal(campaignState(rule.ids.campaignId), 'initial-pending:0');
  assert.equal(terminalEvents(), 0);
  const due = (await storage.listDueCimInitialTouches({ now: '2026-09-30T16:00:00.000Z' }))
    .find((candidate) => candidate.touch_id === rule.ids.touchId);
  assert.equal(due?.preparation_generation, 2);
  const reclaimed = await storage.claimDueCimTouch({ touchId: rule.ids.touchId,
    expectedRowVersion: Number(due.row_version), expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: fill('d'), claimOwner: 'gmail-worker',
    claimExpiresAt: '2026-09-30T16:04:00.000Z', now: '2026-09-30T16:00:00.000Z' });
  assert.equal(reclaimed.claimed, true, JSON.stringify(reclaimed));

  // A single-member follow-up authorizes under fl04c-followup and consumes its reservation.
  for (const basis of ['activation', 'rule']) {
    const followUp = await prepareGate({ container, database, storage, suffix: `follow-up-${basis}`,
      followUp: true, basis });
    const outcome = await followUp.gate();
    assert.equal(outcome.authorized, true, `${basis}: ${JSON.stringify(outcome)}`);
    assert.equal(scalar(`select state from public.deal_hunter_cim_capacity_reservations
      where transmission_id = '${followUp.transmission.id}';`), 'consumed');
  }

  // Follow-up refusals are non-terminal.
  for (const [name, sql, expected] of [
    ['wrong capability', (f) => `update public.deal_hunter_cim_live_provider_authorizations
      set capability = 'fl04b-initial' where transmission_id = '${f.transmission.id}';`,
    'capability_inactive'],
    ['unclaimed touch', (f) => `update public.deal_hunter_cim_campaign_touches
      set claim_expires_at = '2026-09-29T15:59:00.000Z' where id = '${f.ids.touchId}';`,
    'lifecycle_conflict'],
    ['released reservation', (f) => `update public.deal_hunter_cim_capacity_reservations
      set state = 'released', released_at = now(), release_reason = 'synthetic',
        row_version = row_version + 1 where transmission_id = '${f.transmission.id}';`,
    'capacity_reservation_invalid'],
    ['wrong campaign state', (f) => `update public.deal_hunter_cim_campaigns
      set state = 'initial-pending' where id = '${f.ids.campaignId}';`, 'lifecycle_conflict'],
  ]) {
    const followUp = await prepareGate({ container, database, storage,
      suffix: `refuse-${name.replaceAll(' ', '-')}`, followUp: true });
    psql(container, database, sql(followUp));
    const before = campaignState(followUp.ids.campaignId);
    const outcome = await followUp.gate();
    assert.equal(outcome.blockedReason, expected, name);
    assert.equal(campaignState(followUp.ids.campaignId), before, name);
    assert.equal(terminalEvents(), 0, name);
    assert.equal(scalar(`select state from public.deal_hunter_cim_transmissions
      where id = '${followUp.transmission.id}';`), 'prepared', name);
  }
});
