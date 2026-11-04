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
import {
  buildPursueFollowUpPayload,
  isFinalPursueFollowUp,
  loadPursueFollowUpAuthority,
} from '../server/services/pursueCimFollowUpHooks.js';
import { createFakeCimProvider } from '../server/services/fakeCimProvider.js';
import { runCimFollowUpPreparation } from '../server/services/pursueCimFollowUpPreparation.js';
import { runPursueCimReplyPoll } from '../server/services/pursueCimReplyPoller.js';
import { reconcileUnrecordedPursueSends, sweepExpiredPursueCampaigns } from '../server/services/pursueCimSender.js';
import { syncPursueGmailCapabilities } from '../server/services/pursueGmailCapabilities.js';
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
    // A small PostgREST stand-in: select with eq/in/is/not-is-null/lte filters, order, limit
    // and single-row reads, run as service_role.
    from(table) {
      const where = [];
      const orders = [];
      let columns = '*';
      let limit = null;
      let single = '';
      const value = (item) => (item === null ? 'null' : `$v$${String(item)}$v$`);
      const column = (name) => {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsupported column ${name}`);
        return `t.${name}`;
      };
      const read = async () => {
        const filter = where.length ? `where ${where.join(' and ')}` : '';
        const order = orders.length ? `order by ${orders.join(', ')}` : '';
        const rows = JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(q) - '__ord'
          order by q.__ord), '[]'::jsonb)::text from (select t.*, row_number() over
          (${order}) as __ord from public.${table} t ${filter}
          ${order} ${limit === null ? '' : `limit ${limit}`}) q;`));
        const wanted = columns === '*' ? null : columns.split(',').map((name) => name.trim());
        const projected = wanted ? rows.map((row) => Object.fromEntries(wanted
          .map((name) => [name, row[name]]))) : rows;
        if (!single) return { data: projected, error: null };
        if (single === 'single' && projected.length !== 1) {
          return { data: null, error: new Error('expected one row') };
        }
        return { data: projected[0] ?? null, error: null };
      };
      const builder = {
        select(list = '*') { columns = list; return builder; },
        eq(name, item) { where.push(`${column(name)} = ${value(item)}`); return builder; },
        in(name, items) {
          where.push(items.length ? `${column(name)} in (${items.map(value).join(', ')})` : 'false');
          return builder;
        },
        is(name, item) {
          if (item !== null) throw new Error('unsupported is filter');
          where.push(`${column(name)} is null`);
          return builder;
        },
        not(name, operator, item) {
          if (operator !== 'is' || item !== null) throw new Error('unsupported not filter');
          where.push(`${column(name)} is not null`);
          return builder;
        },
        lte(name, item) { where.push(`${column(name)} <= ${value(item)}`); return builder; },
        // insert ... on conflict (onConflict) do update, returning the row (select().single()).
        upsert(payload, { onConflict }) {
          const names = Object.keys(payload).map((name) => column(name).slice(2));
          const target = column(onConflict).slice(2);
          const updates = names.filter((name) => name !== target)
            .map((name) => `${name} = excluded.${name}`).join(', ');
          return { select() { return this; }, single() { return this; },
            then(resolve, reject) {
              try {
                const output = sql(`with input as (select * from jsonb_populate_record(
                  null::public.${table}, $json$${JSON.stringify(payload)}$json$::jsonb))
                  insert into public.${table} as t (${names.join(', ')})
                  select ${names.join(', ')} from input
                  on conflict (${target}) do update set ${updates}
                  returning to_jsonb(t)::text;`);
                return Promise.resolve({ data: JSON.parse(output), error: null }).then(resolve, reject);
              } catch (error) {
                return Promise.resolve({ data: null, error }).then(resolve, reject);
              }
            } };
        },
        order(name, { ascending = true } = {}) {
          orders.push(`${column(name)} ${ascending ? 'asc' : 'desc'}`);
          return builder;
        },
        limit(count) { limit = Number(count); return builder; },
        maybeSingle() { single = 'maybe'; return builder; },
        single() { single = 'single'; return builder; },
        then(resolve, reject) { return read().then(resolve, reject); },
      };
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
  return { ids, transmission: prepared.transmission, capability, writerPath, gate,
    recipientFingerprint, message };
}

/** A disposable postgres:16 with the fresh schema, the Gmail activation chain and no pause. */
async function startPostgres(t, prefix, database) {
  run(dockerCommand, ['image', 'inspect', 'postgres:16']);
  const container = `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`;
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
  return { container, storage };
}

test('PostgreSQL final gate accepts the contact rule basis and single-member follow-ups, and releases unsent Gmail work', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 240_000,
}, async (t) => {
  const database = 'gmail_gate';
  const { container, storage } = await startPostgres(t, 'uckele-gmail-gate', database);
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

test('PostgreSQL lists due follow-ups and prepares a released follow-up again under generation 2', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 240_000,
}, async (t) => {
  const database = 'gmail_follow_ups';
  const { container, storage } = await startPostgres(t, 'uckele-gmail-follow-ups', database);
  const scalar = (sql) => psql(container, database, sql);
  const wallNow = () => new Date().toISOString();
  const fingerprintFor = (suffix) => sha256(stableCanonicalJson({ opportunityId: `opp-gmail-${suffix}`,
    emailHash: sha256(BROKER), provenanceFingerprint: fill('9'),
    contactAuthorityRevision: fill('b') }));
  const seed = (suffix, followUp = true) => seedCampaign(container, database, suffix,
    fingerprintFor(suffix), { followUp, basis: 'activation' });
  const memberAuthority = async ({ opportunityId }) => ({ opportunityId,
    recipientOptions: [{ email: BROKER, displayName: 'Jordan Lee', firstName: 'Jordan',
      provenanceFingerprint: fill('9'), permissionProvenanceFingerprint: fill('a'),
      contactAuthorityRevision: fill('b') }],
    materialsState: { materialsReceived: false, advancedBeyondBrokerOutreach: false,
      evidenceCodes: [] }, preparationBlockers: [], suppression: null });

  // Listing: only the due, scheduled follow-up of an active campaign.
  const due = seed('due');
  seed('initial', false);
  const claimed = seed('claimed');
  assert.equal((await storage.claimDueCimTouch({ touchId: claimed.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest: fill('c'), claimOwner: 'another-worker',
    claimExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), now: wallNow() })).claimed, true);
  const cancelled = seed('cancelled');
  const responded = seed('responded');
  const later = seed('later');
  psql(container, database, `
    update public.deal_hunter_cim_campaign_touches set state = 'cancelled-before-provider'
      where id = '${cancelled.touchId}';
    update public.deal_hunter_cim_campaigns set state = 'responded' where id = '${responded.campaignId}';
    update public.deal_hunter_broker_conversations set state = 'responded'
      where id = '${responded.conversationId}';
    update public.deal_hunter_cim_campaign_touches set due_at = now() + interval '2 days'
      where id = '${later.touchId}';
  `);
  const listed = await storage.listDueCimFollowUpTouches({ now: wallNow() });
  assert.deepEqual(listed.map((candidate) => candidate.touch_id), [due.touchId]);
  const [candidate] = listed;
  assert.deepEqual(Object.keys(candidate).sort(), ['activation_id', 'campaignExpiryAt',
    'campaign_id', 'campaign_recipient_fingerprint', 'campaign_terminal_revision',
    'claim_expires_at', 'conversation_id', 'conversation_recipient_fingerprint',
    'conversation_terminal_revision', 'crm_submission_id', 'dueLocal', 'due_at', 'kind',
    'opportunity_id', 'ordinal', 'preparation_generation', 'recipient_address',
    'recipient_fingerprint', 'row_version', 'state', 'touch_id']);
  assert.deepEqual({ kind: candidate.kind, ordinal: candidate.ordinal, state: candidate.state,
    dueLocal: candidate.dueLocal, generation: candidate.preparation_generation,
    activation: candidate.activation_id, recipient: candidate.recipient_address,
    fingerprint: candidate.recipient_fingerprint, rowVersion: candidate.row_version,
    campaignRevision: candidate.campaign_terminal_revision },
  { kind: 'follow-up-1', ordinal: 1, state: 'scheduled', dueLocal: '2026-09-29T08:00:00-07:00',
    generation: 1, activation: 'gmail-fl04c-followup', recipient: BROKER,
    fingerprint: fingerprintFor('due'), rowVersion: 1, campaignRevision: 0 });
  assert.equal(Date.parse(candidate.campaignExpiryAt), Date.parse(scalar(`select local_expiry_at
    from public.deal_hunter_cim_campaigns where id = '${due.campaignId}';`)));
  assert.equal((await storage.listDueCimFollowUpTouches({
    now: new Date(Date.now() + 3 * 86_400_000).toISOString(), limit: 1 })).length, 1);
  await assert.rejects(storage.listDueCimFollowUpTouches({ now: wallNow(), limit: 101 }),
    /due selection/);

  // The durable follow-up authority read returns the same shape as SQLite.
  const durable = await storage.readCimFollowUpAuthority({ touchId: due.touchId, now: wallNow() });
  assert.deepEqual({ touch: durable.touch.id, campaign: durable.campaign.id,
    conversation: durable.conversation.id, opportunity: durable.opportunity.opportunity_id,
    submission: durable.crmSubmission, owner: durable.crmOwnership.submission_id,
    activation: durable.activation.id, timezone: durable.timezone.iana_timezone,
    initial: durable.initial, signals: durable.signals },
  { touch: due.touchId, campaign: due.campaignId, conversation: due.conversationId,
    opportunity: due.opportunityId,
    submission: { id: due.submissionId, deal_hunter_opportunity_id: due.opportunityId,
      archived_at: null },
    owner: due.submissionId, activation: 'gmail-fl04c-followup', timezone: 'America/Los_Angeles',
    initial: null,
    signals: { replyReceived: false, suppressed: false, unsafeDelivery: false,
      providerPending: false, providerAmbiguous: false } });
  assert.equal(await storage.readCimFollowUpAuthority({ touchId: 'missing', now: wallNow() }), null);
  // The cadence check reads the PostgreSQL rows as they come back (jsonb derivation, +00:00
  // instants), validated against the campaign's acceptance and expiry.
  assert.equal(isFinalPursueFollowUp({ authority: durable, now: wallNow() }), false);
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(isFinalPursueFollowUp({ authority: { ...durable, campaign: { ...durable.campaign,
    local_expiry_at: soon, expiry_derivation: { ...durable.campaign.expiry_derivation,
      expiresAt: soon } } }, now: wallNow() }), true);
  assert.throws(() => isFinalPursueFollowUp({ authority: { ...durable, campaign: {
    ...durable.campaign, local_expiry_at: soon } }, now: wallNow() }),
  /pursue_follow_up_cadence_unavailable/);

  // With no accepted initial to reply to, the production hooks stop before the claim: the
  // touch stays scheduled and unclaimed.
  const gmailConfig = { isProduction: false, dealHunter: { cimProvider: { enabled: true,
    profile: GMAIL_PROFILE, mode: 'production-gmail', provider: 'gmail',
    gmailSenderAddress: SENDER } } };
  const loadAuthority = (input) => loadPursueFollowUpAuthority({ ...input, config: gmailConfig,
    loadMemberAuthority: memberAuthority });
  assert.equal(await loadAuthority({ candidate, storage, now: wallNow() }), null);
  const touchRow = () => scalar(`select state || ':' || row_version || ':'
    || coalesce(claim_token_digest, '-') from public.deal_hunter_cim_campaign_touches
    where id = '${due.touchId}';`);
  const beforeRun = touchRow();
  const stopped = await runCimFollowUpPreparation({ storage, candidate, clock: () => new Date(),
    claimTokenDigest: fill('9'), loadAuthority,
    buildPayload: (input) => buildPursueFollowUpPayload({ ...input, config: gmailConfig }) });
  assert.deepEqual({ prepared: stopped.prepared, blockedReason: stopped.blockedReason },
    { prepared: false, blockedReason: 'authority_unavailable' });
  assert.equal(touchRow(), beforeRun);
  assert.equal(beforeRun, 'scheduled:1:-');
  await assert.rejects(buildPursueFollowUpPayload({ candidate, authority: durable, storage,
    now: wallNow(), config: gmailConfig }), /pursue_follow_up_initial_unavailable/);

  // A follow-up Gmail never accepted is released, listed under generation 2, prepared again
  // although only one follow-up per day and per recipient is allowed, renewed after its lease
  // lapses, and authorized once.
  const released = await prepareGate({ container, database, storage, suffix: 'released',
    followUp: true });
  psql(container, database, `update public.deal_hunter_cim_capability_activations
    set daily_cap = 1, recipient_cap = 1 where id = 'gmail-fl04c-followup';`);
  const gate = await released.gate();
  assert.equal(gate.authorized, true, JSON.stringify(gate));
  const minute = (offset) => new Date(Date.parse(GATE_NOW) + offset * 60_000).toISOString();
  const seam = await storage.enterCimProviderSeam({ transmissionId: released.transmission.id,
    authorizationId: 'authorization-released', writerPath: released.writerPath,
    providerProfile: GMAIL_PROFILE, capability: released.capability,
    payloadDigest: released.transmission.payload_digest,
    boundaryNonceDigest: sha256(gate.boundaryNonce),
    expectedRowVersion: Number(gate.transmission.row_version), actor: 'pursue-cim-sender',
    now: minute(1) });
  assert.equal(seam.entered, true, JSON.stringify(seam));
  const release = await storage.releaseCimProviderPendingUnsent({
    transmissionId: released.transmission.id, payloadDigest: released.transmission.payload_digest,
    expectedRowVersion: Number(gate.transmission.row_version) + 1, provider: 'gmail',
    providerResultCode: 'provider_quota', actor: 'pursue-cim-sender', now: minute(2) });
  assert.equal(release.applied, true, JSON.stringify(release));
  assert.equal(scalar(`select state from public.deal_hunter_cim_capacity_reservations
    where transmission_id = '${released.transmission.id}';`), 'consumed');
  const again = (await storage.listDueCimFollowUpTouches({ now: wallNow() }))
    .find((item) => item.touch_id === released.ids.touchId);
  assert.equal(again?.preparation_generation, 2, JSON.stringify(again));
  const claim = await storage.claimDueCimTouch({ touchId: released.ids.touchId,
    expectedRowVersion: Number(again.row_version), expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: fill('d'), claimOwner: 'gmail-worker',
    claimExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), now: wallNow() });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  const command = (preparationGeneration) => ({ activationId: 'gmail-fl04c-followup',
    claimOwner: 'gmail-worker', recipientFingerprint: released.recipientFingerprint,
    touchIds: [released.ids.touchId], claimTokenDigest: fill('d'),
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    ...released.message, bodyText: 'Synthetic follow-up, second generation',
    preparationGeneration, actor: 'gmail-worker' });
  for (const generation of [1, 3]) {
    const refused = await storage.prepareReservedCimFollowUp(command(generation));
    assert.deepEqual({ prepared: refused.prepared, blockedReason: refused.blockedReason },
      { prepared: false, blockedReason: 'preparation_generation_invalid' }, `generation ${generation}`);
  }
  const reprepared = await storage.prepareReservedCimFollowUp(command(2));
  assert.equal(reprepared.prepared, true, JSON.stringify(reprepared));
  assert.equal(Number(reprepared.transmission.preparation_generation), 2);
  assert.notEqual(reprepared.transmission.id, released.transmission.id);
  assert.equal(reprepared.reservation.state, 'reserved');
  assert.equal((await storage.prepareReservedCimFollowUp(command(2))).existing, true);

  psql(container, database, `
    update public.deal_hunter_cim_capacity_reservations set state = 'expired',
      expired_at = now() - interval '1 second', row_version = row_version + 1
      where id = '${reprepared.reservation.id}';
    update public.deal_hunter_cim_campaign_touches set claim_expires_at = now() - interval '1 second'
      where id = '${released.ids.touchId}';
  `);
  const renewed = await storage.renewReservedCimFollowUp({
    transmissionId: reprepared.transmission.id, touchId: released.ids.touchId,
    activationId: 'gmail-fl04c-followup', recipientFingerprint: released.recipientFingerprint,
    expectedRowVersion: Number(scalar(`select row_version from public.deal_hunter_cim_campaign_touches
      where id = '${released.ids.touchId}';`)), claimTokenDigest: fill('e'), claimOwner: 'gmail-worker',
    claimExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), actor: 'gmail-worker' });
  assert.equal(renewed.renewed, true, JSON.stringify(renewed));
  assert.equal(renewed.transmission.id, reprepared.transmission.id);

  const issued = await storage.issueCimLiveProviderAuthorization({ id: 'authorization-generation-2',
    activationId: 'gmail-fl04c-followup', capability: 'fl04c-followup',
    writerPath: 'pursue-cim-follow-up', transmissionId: reprepared.transmission.id,
    payloadDigest: reprepared.transmission.payload_digest,
    recipientAuthorityDigest: released.recipientFingerprint, providerProfile: GMAIL_PROFILE,
    expiresAt: '2026-09-29T17:00:00.000Z', actor: 'fixture-owner', reason: 'generation 2',
    now: minute(3) });
  assert.equal(issued.issued, true, JSON.stringify(issued));
  const second = await released.gate({ transmissionId: reprepared.transmission.id,
    authorizationId: 'authorization-generation-2', now: minute(4) });
  assert.equal(second.authorized, true, JSON.stringify(second));
  assert.equal(scalar(`select string_agg(t.preparation_generation || ':' || t.state, ','
      order by t.preparation_generation)
    from public.deal_hunter_cim_transmissions t
    join public.deal_hunter_cim_transmission_touches m on m.transmission_id = t.id
    where m.touch_id = '${released.ids.touchId}';`), '1:cancelled-before-provider,2:provider-pending');
  assert.equal(scalar(`select string_agg(state, ',' order by reserved_at, id)
    from public.deal_hunter_cim_capacity_reservations
    where transmission_id = '${reprepared.transmission.id}';`), 'expired,consumed');
});

test('PostgreSQL sender storage: expiry sweep, lapsed claims, expired authorizations, waiting enrollments and the Live sending chain', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 240_000,
}, async (t) => {
  const database = 'pursue_sender';
  const { container, storage } = await startPostgres(t, 'uckele-pursue-sender', database);
  const scalar = (sql) => psql(container, database, sql);
  const realNow = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const recipientFingerprint = (suffix) => sha256(stableCanonicalJson({
    opportunityId: `opp-gmail-${suffix}`, emailHash: sha256(BROKER),
    provenanceFingerprint: fill('9'), contactAuthorityRevision: fill('b') }));
  await storage.setPursueSendControl({ controlKey: 'contact_rule', enabled: true,
    policyVersion: CONTACT_POLICY_VERSION, expectedRevision: 0, actor: 'owner',
    reason: 'sender test', now: seededAt });

  // Day-28 expiry: the sweep expires the campaign and cancels its scheduled touch, once.
  const expiring = seedCampaign(container, database, 'expiring', recipientFingerprint('expiring'),
    { followUp: true, basis: 'rule' });
  const expiry = Date.parse(scalar(`select to_jsonb(local_expiry_at) #>> '{}'
    from public.deal_hunter_cim_campaigns where id = '${expiring.campaignId}';`));
  assert.deepEqual(await storage.listExpiredCimCampaigns({ now: iso(expiry - 60_000) }), []);
  const [listed] = await storage.listExpiredCimCampaigns({ now: iso(expiry + 60_000) });
  assert.deepEqual(Object.keys(listed).sort(), ['conversation_id', 'id', 'local_expiry_at',
    'opportunity_id', 'row_version', 'state', 'terminal_revision']);
  assert.equal(listed.id, expiring.campaignId);
  assert.equal(listed.row_version, 1);
  assert.equal(await sweepExpiredPursueCampaigns({ storage, now: iso(expiry + 60_000) }), 1);
  assert.equal(scalar(`select state || ':' || reason_code from public.deal_hunter_cim_campaigns
    where id = '${expiring.campaignId}';`), 'expired:campaign_expired');
  assert.equal(scalar(`select state || ':' || terminal_reason
    from public.deal_hunter_cim_campaign_touches where id = '${expiring.touchId}';`),
  'cancelled-before-provider:campaign_expired');
  assert.equal(await sweepExpiredPursueCampaigns({ storage, now: iso(expiry + 120_000) }), 0);

  // A follow-up whose claimer died before preparing is listed again (Ruling L).
  const lapsedFollowUp = seedCampaign(container, database, 'lapsed-follow-up',
    recipientFingerprint('lapsed-follow-up'), { followUp: true, basis: 'rule' });
  const claimed = await storage.claimDueCimTouch({ touchId: lapsedFollowUp.touchId,
    expectedRowVersion: 1, expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, claimTokenDigest: fill('d'),
    claimOwner: 'crashed-worker', claimExpiresAt: iso(realNow + 60_000), now: iso(realNow) });
  assert.equal(claimed.claimed, true, JSON.stringify(claimed));
  assert.deepEqual((await storage.listDueCimFollowUpTouches({ now: iso(realNow + 30_000) }))
    .map((row) => row.touch_id), []);
  const relisted = await storage.listDueCimFollowUpTouches({ now: iso(realNow + 120_000) });
  assert.deepEqual(relisted.map((row) => [row.touch_id, row.state]),
    [[lapsedFollowUp.touchId, 'claimed']]);

  // An initial prepared under a claim that then lapsed: listed, renewed, sent through a new
  // authorization once the expired one is retired.
  const initial = seedCampaign(container, database, 'lapsed-initial',
    recipientFingerprint('lapsed-initial'), { followUp: false, basis: 'rule' });
  const t0 = Date.parse('2026-09-29T15:30:00.000Z');
  const at = (minutes) => iso(t0 + minutes * 60_000);
  assert.equal((await storage.claimDueCimTouch({ touchId: initial.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest: fill('e'), claimOwner: 'crashed-worker', claimExpiresAt: at(4),
    now: at(0) })).claimed, true);
  const prepared = await storage.prepareCimTransmission({ touchIds: [initial.touchId],
    claimTokenDigest: fill('e'), expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, preparationGeneration: 1,
    payloadVersion: 'deal-hunter-cim-pursue-initial-v2', fromAddress: SENDER,
    toAddresses: [BROKER], ccAddresses: [], bccAddresses: [], replyToAddress: SENDER,
    subject: 'CIM / NDA request for Acme Plumbing', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: [`cim_touch_id=${initial.touchId}`],
    actor: 'crashed-worker', now: at(1) });
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
  const transmission = prepared.transmission;
  assert.deepEqual(await storage.listLapsedCimPreparedTouches({ now: at(3) }), []);
  const [lapsed] = await storage.listLapsedCimPreparedTouches({ now: at(10) });
  assert.deepEqual(Object.keys(lapsed).sort(), ['campaign_id', 'campaign_state',
    'claim_expires_at', 'conversation_id', 'due_local', 'kind', 'opportunity_id',
    'preparation_generation',
    'recipient_fingerprint', 'row_version', 'touch_id', 'transmission_id']);
  assert.equal(lapsed.touch_id, initial.touchId);
  assert.equal(lapsed.transmission_id, transmission.id);
  assert.equal(lapsed.kind, 'initial');
  assert.equal(lapsed.preparation_generation, 1);
  const renewal = { touchId: initial.touchId, transmissionId: transmission.id,
    expectedRowVersion: lapsed.row_version, claimTokenDigest: fill('f'),
    claimOwner: 'pursue-cim-sender', claimExpiresAt: at(14), actor: 'pursue-cim-sender',
    now: at(10) };
  const tooLong = await storage.renewLapsedCimInitialClaim({ ...renewal, claimExpiresAt: at(16) });
  assert.equal(tooLong.blockedReason, 'renewal_authority_changed');
  const renewed = await storage.renewLapsedCimInitialClaim(renewal);
  assert.equal(renewed.renewed, true, JSON.stringify(renewed));
  assert.equal(renewed.transmission.id, transmission.id);
  assert.equal(renewed.touch.claim_token_digest, fill('f'));
  assert.equal(renewed.touch.row_version, lapsed.row_version + 1);
  assert.equal((await storage.renewLapsedCimInitialClaim(renewal)).existing, true);
  assert.equal((await storage.renewLapsedCimInitialClaim({ ...renewal, claimTokenDigest: fill('0'),
    expectedRowVersion: lapsed.row_version + 1, now: at(11) })).terminal, true);
  assert.equal(scalar(`select count(*) from public.deal_hunter_cim_audit_events
    where event_type = 'touch-claim-renewed';`), '1');

  const issue = (id, now, expiresAt) => storage.issueCimLiveProviderAuthorization({ id,
    activationId: 'gmail-fl04b-initial', capability: 'fl04b-initial',
    writerPath: 'pursue-cim-initial', transmissionId: transmission.id,
    payloadDigest: transmission.payload_digest,
    recipientAuthorityDigest: recipientFingerprint('lapsed-initial'),
    providerProfile: GMAIL_PROFILE, expiresAt, actor: 'pursue-cim-sender',
    reason: 'sender test', now });
  assert.equal((await issue('authorization-first', at(11), at(13))).issued, true);
  const blocked = await issue('authorization-early', at(12), at(20));
  assert.equal(blocked.blockedReason, 'authorization_exists');
  assert.equal(blocked.authorization.id, 'authorization-first');
  const reissued = await issue('authorization-second', at(13), at(20));
  assert.equal(reissued.issued, true, JSON.stringify(reissued));
  assert.equal(scalar(`select (withdrawn_at is not null and consumed_at is null)::text
    from public.deal_hunter_cim_live_provider_authorizations where id = 'authorization-first';`),
  'true');
  assert.equal(scalar(`select count(*) from public.deal_hunter_cim_audit_events
    where event_type = 'authorization-expired' and authorization_id = 'authorization-first';`), '1');

  // A send whose provider seam was entered and that recorded no outcome.
  const pending = await prepareGate({ container, database, storage, suffix: 'pending',
    basis: 'rule' });
  const gate = await pending.gate();
  assert.equal(gate.authorized, true, JSON.stringify(gate));
  const seam = await storage.enterCimProviderSeam({ transmissionId: pending.transmission.id,
    authorizationId: 'authorization-pending', writerPath: pending.writerPath,
    providerProfile: GMAIL_PROFILE, capability: pending.capability,
    payloadDigest: pending.transmission.payload_digest,
    boundaryNonceDigest: sha256(gate.boundaryNonce),
    expectedRowVersion: Number(gate.transmission.row_version), actor: 'pursue-cim-sender',
    now: GATE_NOW });
  assert.equal(seam.entered, true, JSON.stringify(seam));
  // Ruling M never applies to an entered seam.
  const seamNotEntered = (transmission, rowVersion, now) => storage.releaseCimProviderPendingUnsent({
    transmissionId: transmission.id, payloadDigest: transmission.payload_digest,
    expectedRowVersion: rowVersion, provider: 'gmail',
    providerResultCode: 'provider_seam_not_entered', actor: 'pursue-cim-sender', now });
  assert.equal((await seamNotEntered(pending.transmission, Number(gate.transmission.row_version) + 1,
    iso(Date.parse(GATE_NOW) + 30 * 60_000))).conflict, true);
  assert.deepEqual(await storage.listCimProviderPendingTransmissions({
    enteredBefore: iso(Date.parse(GATE_NOW) - 60_000) }), []);
  const [unrecorded] = await storage.listCimProviderPendingTransmissions({
    enteredBefore: iso(Date.parse(GATE_NOW) + 10 * 60_000) });
  assert.equal(unrecorded.id, pending.transmission.id);
  assert.equal(unrecorded.state, 'provider-pending');
  assert.equal(unrecorded.invocation_authority_count, 1);
  assert.equal(typeof unrecorded.row_version, 'number');
  // Gmail has no such message: finalized ambiguous for the owner, never sent again.
  const notFound = { async findSent() { return { found: false }; } };
  const reconcileConfig = { isProduction: false, dealHunter: { cimProvider: { enabled: true,
    profile: GMAIL_PROFILE, mode: 'production-gmail', provider: 'gmail',
    gmailSenderAddress: SENDER } } };
  const tooSoon = await reconcileUnrecordedPursueSends({ storage, mailProvider: notFound,
    providerProfile: GMAIL_PROFILE, now: iso(Date.parse(GATE_NOW) + 5 * 60_000),
    config: reconcileConfig });
  assert.deepEqual(tooSoon, { reconciled: 0, ambiguous: 0, skipped: {} });
  const ambiguous = await reconcileUnrecordedPursueSends({ storage, mailProvider: notFound,
    providerProfile: GMAIL_PROFILE, now: iso(Date.parse(GATE_NOW) + 15 * 60_000),
    config: reconcileConfig });
  assert.deepEqual(ambiguous, { reconciled: 0, ambiguous: 1, skipped: {} });
  assert.equal(scalar(`select state || ':' || provider || ':' || provider_result_code
    from public.deal_hunter_cim_transmissions where id = '${pending.transmission.id}';`),
  'ambiguous:gmail:gmail_send_unrecorded');
  assert.equal(scalar(`select state from public.deal_hunter_cim_campaigns
    where id = '${pending.ids.campaignId}';`), 'provider-ambiguous');
  // Gmail has it: reconciled as accepted, its thread stored and the follow-up scheduled.
  const delivered = await prepareGate({ container, database, storage, suffix: 'delivered',
    basis: 'rule' });
  const deliveredGate = await delivered.gate({ now: iso(Date.parse(GATE_NOW) + 1000) });
  assert.equal(deliveredGate.authorized, true, JSON.stringify(deliveredGate));
  assert.equal((await storage.enterCimProviderSeam({ transmissionId: delivered.transmission.id,
    authorizationId: 'authorization-delivered', writerPath: delivered.writerPath,
    providerProfile: GMAIL_PROFILE, capability: delivered.capability,
    payloadDigest: delivered.transmission.payload_digest,
    boundaryNonceDigest: sha256(deliveredGate.boundaryNonce),
    expectedRowVersion: Number(deliveredGate.transmission.row_version),
    actor: 'pursue-cim-sender', now: iso(Date.parse(GATE_NOW) + 1000) })).entered, true);
  const found = { async findSent() { return { found: true, messageId: 'gmail-message-1',
    threadId: 'gmail-thread-delivered' }; } };
  const accepted = await reconcileUnrecordedPursueSends({ storage, mailProvider: found,
    providerProfile: GMAIL_PROFILE, now: iso(Date.parse(GATE_NOW) + 15 * 60_000),
    config: reconcileConfig });
  assert.deepEqual(accepted, { reconciled: 1, ambiguous: 0, skipped: {} });
  assert.equal(scalar(`select state || ':' || provider_message_id
    from public.deal_hunter_cim_transmissions where id = '${delivered.transmission.id}';`),
  'accepted:gmail-message-1');
  assert.equal(scalar(`select gmail_thread_id from public.deal_hunter_broker_conversations
    where id = '${delivered.ids.conversationId}';`), 'gmail-thread-delivered');
  assert.equal(scalar(`select state || ':' || kind from public.deal_hunter_cim_campaign_touches
    where campaign_id = '${delivered.ids.campaignId}' and kind <> 'initial';`),
  'scheduled:follow-up-1');

  // Ruling M: a gate-authorized send whose seam was never entered is released, after its grace.
  const unentered = await prepareGate({ container, database, storage, suffix: 'unentered',
    basis: 'rule' });
  const unenteredGate = await unentered.gate({ now: iso(Date.parse(GATE_NOW) + 2000) });
  assert.equal(unenteredGate.authorized, true, JSON.stringify(unenteredGate));
  const authorizedAt = Date.parse(GATE_NOW) + 2000;
  assert.deepEqual(await storage.listCimUnenteredProviderPendingTransmissions({
    authorizedBefore: iso(authorizedAt - 60_000) }), []);
  const [stuck] = await storage.listCimUnenteredProviderPendingTransmissions({
    authorizedBefore: iso(authorizedAt + 10 * 60_000) });
  assert.equal(stuck.id, unentered.transmission.id);
  assert.equal(stuck.authorization_provider_profile, GMAIL_PROFILE);
  assert.equal(stuck.provider_seam_entered_at, null);
  assert.equal((await seamNotEntered(stuck, stuck.row_version,
    iso(authorizedAt + 5 * 60_000))).conflict, true);
  const releasedUnentered = await seamNotEntered(stuck, stuck.row_version,
    iso(authorizedAt + 11 * 60_000));
  assert.equal(releasedUnentered.applied, true, JSON.stringify(releasedUnentered));
  assert.equal(releasedUnentered.transmission.provider_result_code, 'provider_seam_not_entered');
  assert.equal(scalar(`select state || ':' || coalesce(transmission_id, '-')
    from public.deal_hunter_cim_campaign_touches where id = '${unentered.ids.touchId}';`),
  'scheduled:-');
  assert.equal(scalar(`select state from public.deal_hunter_cim_campaigns
    where id = '${unentered.ids.campaignId}';`), 'initial-pending');
  assert.equal((await seamNotEntered(stuck, stuck.row_version,
    iso(authorizedAt + 12 * 60_000))).replay, true);

  // Waiting enrollments are listed with their decisions.
  scalar(`
    insert into public.deal_hunter_opportunities (opportunity_id, created_at, updated_at,
      canonical_name, identity_version, discovery_state) values ('opp-waiting', '${seededAt}',
      '${seededAt}', 'Waiting Co', 'cim-identity-v1', 'known_prospective');
    insert into public.deal_hunter_owner_decision_events (id, idempotency_key, request_digest,
      opportunity_id, action, actor, expected_discovery_revision, expected_material_revision,
      observed_discovery_revision, observed_material_revision, policy_version, created_at)
      values ('decision-waiting', 'idem-waiting', '${fill('a')}', 'opp-waiting', 'pursue',
        'fixture-owner', 0, 0, 0, 0, 'owner-decision-v1', '${seededAt}');
    insert into public.deal_hunter_pursuit_enrollments (id, decision_event_id, opportunity_id,
      state, reason_code, authority_digest, created_at, updated_at, row_version)
      values ('enrollment-waiting', 'decision-waiting', 'opp-waiting', 'waiting-on-eligibility',
        'contact_permission_missing', '${fill('b')}', '${seededAt}', '${seededAt}', 2);
  `);
  const waiting = await storage.listWaitingPursuitEnrollments({ limit: 10 });
  assert.deepEqual(waiting.map(({ enrollment, decision }) => [enrollment.id, decision?.id,
    enrollment.row_version]), [['enrollment-waiting', 'decision-waiting', 2]]);

  // Live sending: an intact production-gmail-v1 chain is kept; off withdraws it; on records it.
  const now = iso(realNow);
  assert.equal((await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner',
    now })).applied, false);
  const off = await syncPursueGmailCapabilities({ storage, enabled: false, actor: 'owner', now });
  assert.deepEqual(off.withdrawn.sort(), ['gmail-fl04a-safety', 'gmail-fl04b-enrollment',
    'gmail-fl04b-initial', 'gmail-fl04c-followup']);
  // Ruling N: the prepared initial is cancelled before the provider and its touch rescheduled.
  assert.equal(off.released, 1);
  assert.equal(scalar(`select state from public.deal_hunter_cim_transmissions
    where id = '${transmission.id}';`), 'cancelled-before-provider');
  assert.equal(scalar(`select state || ':' || coalesce(transmission_id, '-')
    from public.deal_hunter_cim_campaign_touches where id = '${initial.touchId}';`),
  'scheduled:-');
  assert.equal(scalar(`select (withdrawn_at is not null)::text
    from public.deal_hunter_cim_live_provider_authorizations where id = 'authorization-second';`),
  'true');
  assert.deepEqual(await storage.listCurrentCimCapabilityActivations(), []);
  assert.equal(scalar(`select coalesce(public.pursue_cim_current_activation_v1('fl04c-followup',
    now()), 'none');`), 'none');
  const on = await syncPursueGmailCapabilities({ storage, enabled: true, actor: 'owner',
    now: iso(realNow + 1000) });
  assert.equal(on.applied, true);
  const current = await storage.listCurrentCimCapabilityActivations();
  assert.deepEqual(current.map((row) => [row.capability, row.provider_profile, row.mode]), [
    ['fl04a-safety', GMAIL_PROFILE, 'active'], ['fl04b-enrollment', GMAIL_PROFILE, 'active'],
    ['fl04b-initial', GMAIL_PROFILE, 'active'], ['fl04c-followup', GMAIL_PROFILE, 'active']]);
  assert.equal(scalar(`select public.pursue_cim_current_activation_v1('fl04c-followup', now());`),
    on.activations['fl04c-followup'].id);
  assert.equal(scalar(`select count(*) from public.deal_hunter_cim_audit_events
    where event_type in ('capability-activation', 'capability-withdrawn')
      and actor = 'owner';`), '8');
});

test('PostgreSQL reply poller: gmail-thread evidence, ours, owner, bounce, auto-reply, stop and replay', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for disposable PostgreSQL integration',
  timeout: 240_000,
}, async (t) => {
  const database = 'reply_poller';
  const { container, storage } = await startPostgres(t, 'uckele-reply-poller', database);
  const scalar = (sql) => psql(container, database, sql);
  const marker = 'PG-BODY-MARKER-51c2';
  const recipientFingerprint = (suffix) => sha256(stableCanonicalJson({
    opportunityId: `opp-gmail-${suffix}`, emailHash: sha256(BROKER),
    provenanceFingerprint: fill('9'), contactAuthorityRevision: fill('b') }));
  const seeded = {};
  for (const suffix of ['reply', 'owner', 'bounce', 'auto', 'stop']) {
    seeded[suffix] = seedCampaign(container, database, `poll-${suffix}`,
      recipientFingerprint(`poll-${suffix}`), { followUp: true, basis: 'rule' });
  }
  // A conversation whose prepared transmission is in the thread: our own message is ignored.
  const ours = seedCampaign(container, database, 'poll-ours', recipientFingerprint('poll-ours'),
    { followUp: false, basis: 'rule' });
  const t0 = Date.parse('2026-09-29T15:30:00.000Z');
  const at = (minutes) => new Date(t0 + minutes * 60_000).toISOString();
  assert.equal((await storage.claimDueCimTouch({ touchId: ours.touchId, expectedRowVersion: 1,
    expectedCampaignTerminalRevision: 0, expectedConversationTerminalRevision: 0,
    claimTokenDigest: fill('e'), claimOwner: 'pursue-cim-sender', claimExpiresAt: at(4),
    now: at(0) })).claimed, true);
  const prepared = await storage.prepareCimTransmission({ touchIds: [ours.touchId],
    claimTokenDigest: fill('e'), expectedCampaignTerminalRevision: 0,
    expectedConversationTerminalRevision: 0, preparationGeneration: 1,
    payloadVersion: 'deal-hunter-cim-pursue-initial-v2', fromAddress: SENDER,
    toAddresses: [BROKER], ccAddresses: [], bccAddresses: [], replyToAddress: SENDER,
    subject: 'CIM / NDA request for Acme Plumbing', bodyText: 'Synthetic body',
    bodyHtmlSanitized: '<p>Synthetic body</p>', tags: [`cim_touch_id=${ours.touchId}`],
    actor: 'pursue-cim-sender', now: at(1) });
  assert.equal(prepared.prepared, true, JSON.stringify(prepared));
  await storage.setCimConversationGmailThread({ conversationId: ours.conversationId,
    gmailThreadId: 'gmail-thread-poll-ours', now: at(2) });
  assert.deepEqual((await storage.listGmailConversationSentIdentities({
    conversationIds: [ours.conversationId, seeded.reply.conversationId] }))
    .map((row) => [row.conversationId, row.transmissionId, row.fromAddress]),
  [[ours.conversationId, prepared.transmission.id, SENDER]]);

  // gmail-thread is the first evidence method; commands without the key are unchanged.
  const resolve = (extra = {}) => storage.resolvePursueCimInboundEvidence({ replyToAddresses: [],
    provider: 'gmail', providerMessageIds: [], rfcMessageIds: [], taggedConversationId: '',
    taggedTransmissionId: '', taggedTouchIds: [], ...extra });
  const exact = await resolve({ gmailThreadIds: ['gmail-thread-poll-reply'],
    taggedConversationId: seeded.reply.conversationId });
  assert.equal(exact.exact, true);
  assert.equal(exact.method, 'gmail-thread');
  assert.equal(exact.conversation.id, seeded.reply.conversationId);
  assert.equal((await resolve({ gmailThreadIds: ['gmail-thread-poll-reply'],
    taggedConversationId: seeded.owner.conversationId })).ambiguous, true);
  assert.equal((await resolve()).method, 'none');
  await assert.rejects(resolve({ gmailThreadIds: ['x', 'x'] }), /Invalid Pursue CIM inbound evidence/);

  await storage.saveGmailConnection({ emailAddress: SENDER,
    refreshTokenCiphertext: 'v1.aXYtYnl0ZXM=.dGFnLWJ5dGVz.Y2lwaGVydGV4dA==',
    grantedScopes: ['https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly'], historyCheckpoint: '0',
    connectedBy: 'owner', now: seededAt });
  let clock = Date.parse(GATE_NOW);
  const now = () => new Date(clock += 1000);
  const mailbox = createFakeCimProvider({ senderAddress: SENDER, now });
  const inject = (suffix, headers, body) => mailbox.injectReply(`gmail-thread-poll-${suffix}`, {
    internalDate: now().toISOString(), bodyPrefix: `${body} ${marker}`,
    headers: { from: `Jordan Lee <${BROKER}>`, contentType: 'text/plain', ...headers } });
  inject('ours', { from: SENDER, messageId: `<${prepared.transmission.id}@uckele.example.test>` },
    'Our own initial email');
  inject('reply', { from: 'Assistant <assistant@brokerage.test>' }, 'NDA attached.');
  inject('owner', { from: SENDER, messageId: '<CAowner@mail.gmail.com>' }, 'Calling you now.');
  inject('bounce', { from: 'MAILER-DAEMON@googlemail.com',
    contentType: 'multipart/report; report-type=delivery-status' }, 'Delivery failed.');
  inject('auto', { autoSubmitted: 'auto-replied' }, 'Out of office.');
  const poll = () => runPursueCimReplyPoll({ storage, mailProvider: mailbox, now });

  const first = await poll();
  assert.deepEqual(first, { processed: 5, responded: 1, ownerReplied: 1, bounced: 1,
    autoReplies: 1, stopped: 0, failed: 0, checkpointExpired: false, checkpointAdvanced: true });
  const campaign = (ids) => scalar(`select state || ':' || coalesce(reason_code, '-')
    from public.deal_hunter_cim_campaigns where id = '${ids.campaignId}';`);
  const touch = (ids) => scalar(`select state || ':' || coalesce(terminal_reason, '-')
    from public.deal_hunter_cim_campaign_touches where id = '${ids.touchId}';`);
  assert.equal(campaign(seeded.reply), 'responded:reply_received');
  assert.equal(touch(seeded.reply), 'cancelled-before-provider:reply_received');
  assert.equal(campaign(seeded.owner), 'stopped:owner_replied');
  assert.equal(touch(seeded.owner), 'cancelled-before-provider:owner_replied');
  assert.equal(campaign(seeded.bounce), 'action-required:recipient_bounced');
  assert.equal(touch(seeded.bounce), 'cancelled-before-provider:recipient_bounced');
  assert.equal(scalar(`select state from public.deal_hunter_broker_conversations
    where id = '${seeded.bounce.conversationId}';`), 'reply-review-required');
  assert.equal(campaign(seeded.auto), 'active-follow-up:-');
  assert.equal(touch(seeded.auto), 'scheduled:-');
  assert.equal(campaign(ours), 'initial-pending:awaiting-window');
  assert.equal(scalar(`select string_agg(distinct evidence_type || '/' || actor, ',')
    from public.deal_hunter_cim_terminal_events where scope = 'conversation';`),
  'gmail-inbound-gmail-thread/pursue-cim-reply-poller');
  assert.equal(scalar(`select string_agg(classification, ',' order by classification)
    from public.deal_hunter_gmail_reply_messages;`), 'auto-reply,bounce,ours,owner,reply');
  assert.equal((await storage.getGmailConnection()).history_checkpoint, '5');
  const terminalEvents = scalar('select count(*) from public.deal_hunter_cim_terminal_events;');

  // An expired checkpoint returns every message of the open threads; none is applied twice.
  mailbox.expireCheckpointNext();
  const replay = await poll();
  assert.equal(replay.checkpointExpired, true);
  assert.equal(replay.processed, 0, JSON.stringify(replay));
  assert.equal(scalar('select count(*) from public.deal_hunter_cim_terminal_events;'), terminalEvents);
  assert.deepEqual(await storage.recordGmailReplyMessage({ gmailMessageId: 'fake-msg-2',
    gmailThreadId: 'gmail-thread-poll-reply', conversationId: seeded.reply.conversationId,
    classification: 'reply', fromFingerprint: null, messageAt: null, now: GATE_NOW }),
  { applied: false, replay: true });

  // A stop word responds and suppresses the recipient through the existing suppression write.
  inject('stop', {}, 'Please remove me from your list.');
  const stop = await poll();
  assert.equal(stop.stopped, 1, JSON.stringify(stop));
  assert.equal(campaign(seeded.stop), 'responded:reply_received');
  const suppression = await storage.getActiveEmailSuppression(BROKER);
  assert.equal(suppression.reason, 'explicit-opt-out');
  assert.equal(suppression.source, 'gmail-reply');
  assert.equal(scalar(`select count(*) from public.deal_hunter_gmail_reply_messages t
    where to_jsonb(t)::text like '%${marker}%' or to_jsonb(t)::text like '%brokerage.test%';`), '0');
  assert.equal(scalar(`select count(*) from public.deal_hunter_cim_terminal_events t
    where to_jsonb(t)::text like '%${marker}%';`), '0');
});
