import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(
  repositoryRoot,
  'supabase/migrations/20260901120000_deal_hunter_manual_follow_up_atomicity.sql',
);
const schemaPath = path.join(repositoryRoot, 'supabase/schema.sql');
const parentCommit = 'd422f78a6bc2acb6531931b2da20614bd728401e';
const initialAt = '2026-08-28T18:00:00.000Z';
const enrolledAt = '2026-09-01T16:00:00.000Z';
const firstDueAt = '2026-09-01T17:00:00.000Z';
const integrationEnabled = process.env.DEAL_HUNTER_POSTGRES_INTEGRATION === '1';
const dockerCommand = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';

function run(command, args, { input = undefined, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function docker(args, options = {}) {
  return run(dockerCommand, args, options);
}

function waitForPostgres(containerName) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const logs = docker(['logs', containerName], { allowFailure: true });
    const readyEvents = `${logs.stdout}\n${logs.stderr}`.match(/database system is ready to accept connections/g)?.length || 0;
    const ready = docker(['exec', containerName, 'pg_isready', '-U', 'postgres'], { allowFailure: true });
    if (readyEvents >= 2 && ready.status === 0) return;
    Atomics.wait(signal, 0, 0, 100);
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

function psql(containerName, database, sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', containerName,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
  ], { input: sql, allowFailure });
}

function psqlAsync(containerName, database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerCommand, [
      'exec', '-i', containerName,
      'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
    ], { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, pid: child.pid }));
    child.stdin.end(sql);
  });
}

function quote(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return `${quote(JSON.stringify(value))}::jsonb`;
}

function parseJsonResult(result) {
  const output = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return output ? JSON.parse(output) : null;
}

function canonicalMarker(overrides = {}) {
  return {
    version: 'deal-hunter-manual-follow-up-v1',
    mode: 'operator-approved',
    maximumFollowUps: 5,
    cadencePolicy: 'accepted-local-date-plus-2-weekend-forward-0900-pt-v1',
    enrolledAt,
    enrolledBy: 'storage-admin',
    ...overrides,
  };
}

function activity(submissionId, createdAt, eventType) {
  return {
    id: randomUUID(),
    submission_id: submissionId,
    created_at: createdAt,
    actor: 'storage-admin',
    role: 'admin',
    event_type: eventType,
    summary: `PostgreSQL Task 2 integration event ${eventType}.`,
    metadata: { fixture: true },
  };
}

function deterministicCommunicationId(requestId, followUpNumber) {
  return createHash('sha256')
    .update(`crm-communication:${requestId}:follow-up:${followUpNumber}`)
    .digest('hex');
}

function sqliteSubmission(fixture) {
  return {
    id: fixture.submissionId,
    created_at: initialAt,
    updated_at: initialAt,
    status: 'review',
    spam_score: 0,
    spam_reasons: [],
    delivery_provider: 'manual',
    delivery_status: 'not-applicable',
    delivery_error: '',
    crm_status: 'not-applicable',
    crm_error: '',
    source: 'manual-follow-up-postgres-parity',
    ip_hash: '',
    user_agent: '',
    name: `Contact ${fixture.suffix}`,
    email: `${fixture.suffix}@example.test`,
    phone: '',
    company: `Company ${fixture.suffix}`,
    role: 'Broker',
    message: 'Storage integration parity fixture.',
    status_updated_at: initialAt,
    listing_url: `https://example.test/${fixture.suffix}`,
    business_website: '',
    prospectus_url: '',
    asking_price: '',
    ttm_revenue: '',
    ttm_ebitda: '',
    ebitda_multiple: '',
    net_margin: '',
    business_age: '',
    sba_eligible: 'unknown',
    broker_name: 'Storage Broker',
    broker_email: `${fixture.suffix}@example.test`,
    broker_phone: '',
    seller_name: '',
    seller_email: '',
    seller_phone: '',
    lead_type: 'broker',
    priority: 'normal',
    tags: [],
    assigned_to: '',
    notes: '',
    follow_up_state: 'needs-response',
    next_action_at: null,
    last_contacted_at: null,
    metadata: {},
  };
}

function sqliteRequest(fixture) {
  return {
    id: fixture.requestId,
    created_at: initialAt,
    updated_at: initialAt,
    opportunity_id: `opportunity-${fixture.requestId}`,
    deal_key: `deal-${fixture.suffix}`,
    recipient_email: `${fixture.suffix}@example.test`,
    requested_by: 'phase-2-admin',
    status: 'sent',
    request_state: 'provider_accepted',
    delivery_state: 'accepted',
    delivery_state_at: initialAt,
    follow_up_state: 'not-scheduled',
    first_requested_at: initialAt,
    first_provider_accepted_at: initialAt,
    submission_id: fixture.submissionId,
    follow_up_count: 0,
    last_follow_up_at: null,
    next_follow_up_at: null,
    metadata: {
      manualApproval: {
        approvedAt: initialAt,
        approvedBy: 'phase-2-admin',
        followUpPolicy: 'none',
      },
    },
  };
}

function sqliteCommunication(fixture, { id, followUpNumber = 1, occurredAt } = {}) {
  return {
    id,
    submission_id: fixture.submissionId,
    deal_key: `deal-${fixture.suffix}`,
    cim_request_id: fixture.requestId,
    direction: 'outbound',
    channel: 'email',
    source: 'deal-hunter',
    kind: 'cim-follow-up',
    provider: 'resend',
    provider_message_id: `provider-${id}`,
    source_event_id: null,
    idempotency_key: `deal-hunter-cim-${fixture.requestId}-follow-up-${followUpNumber}`,
    in_reply_to: null,
    reply_to_address: `${fixture.requestId}@reply.example.test`,
    from_address: 'team@example.test',
    to_addresses: [`${fixture.suffix}@example.test`],
    cc_addresses: [],
    bcc_addresses: [],
    subject: 'Requested materials follow-up',
    body_text: `Follow-Up ${followUpNumber}`,
    body_html_sanitized: `<p>Follow-Up ${followUpNumber}</p>`,
    occurred_at: occurredAt,
    created_at: occurredAt,
    updated_at: occurredAt,
    delivery_state: 'accepted',
    delivery_state_at: occurredAt,
    content_state: 'complete',
    content_attempt_count: 1,
    content_last_error: null,
    content_next_attempt_at: null,
    attachment_metadata: [],
    assigned_at: occurredAt,
    assigned_by: 'storage-admin',
    created_by: 'storage-admin',
    updated_by: 'storage-admin',
    metadata: { followUpNumber, templateVersion: 'deal-hunter-cim-follow-up-v1' },
  };
}

function normalizedTimestamp(value) {
  return value ? new Date(value).toISOString() : null;
}

function normalizedCoreResult(result) {
  return {
    applied: result.applied,
    reason: result.reason,
    alreadyFinalized: result.alreadyFinalized,
    followUpCount: result.request?.follow_up_count ?? null,
    followUpState: result.request?.follow_up_state ?? null,
    lastFollowUpAt: normalizedTimestamp(result.request?.last_follow_up_at),
    nextFollowUpAt: normalizedTimestamp(result.request?.next_follow_up_at),
    acceptedTouches: (result.request?.metadata?.manualFollowUp?.acceptedTouches || []).map((touch) => ({
      followUpNumber: touch.followUpNumber,
      communicationId: touch.communicationId,
      acceptedAt: normalizedTimestamp(touch.acceptedAt),
    })),
    activityEventType: result.activity?.event_type ?? null,
  };
}

async function seedSqliteParityFixture(storage, fixture) {
  await storage.insertSubmission(sqliteSubmission(fixture));
  await storage.upsertDealHunterCimRequest(sqliteRequest(fixture));
}

let fixtureNumber = 0;

function seedFixture(containerName, database, suffix, {
  followUpCount = 0,
  followUpState = 'not-scheduled',
  nextFollowUpAt = null,
  requestStatus = 'sent',
  requestState = 'provider_accepted',
  deliveryState = 'accepted',
  marker = null,
} = {}) {
  fixtureNumber += 1;
  const serial = String(fixtureNumber).padStart(12, '0');
  const submissionId = `00000000-0000-4000-8000-${serial}`;
  const requestId = `pg-${suffix}-${fixtureNumber}`;
  const metadata = {
    manualApproval: { approvedAt: initialAt, approvedBy: 'phase-2-admin', followUpPolicy: 'none' },
    ...(marker === null ? {} : { manualFollowUp: marker }),
  };
  psql(containerName, database, `
    insert into public.contact_submissions (
      id, created_at, updated_at, status, delivery_provider, delivery_status,
      crm_status, source, ip_hash, name, email, message, lead_type, metadata
    ) values (
      ${quote(submissionId)}::uuid, ${quote(initialAt)}::timestamptz, ${quote(initialAt)}::timestamptz,
      'review', 'manual', 'not-applicable', 'not-applicable', 'manual-follow-up-postgres-test',
      '', ${quote(`Contact ${suffix}`)}, ${quote(`${suffix}@example.test`)}, 'Storage integration fixture.',
      'broker', '{}'::jsonb
    );
    insert into public.deal_hunter_cim_requests (
      id, created_at, updated_at, deal_key, recipient_email, requested_by,
      status, request_state, delivery_state, delivery_state_at, follow_up_state,
      first_requested_at, first_provider_accepted_at, submission_id,
      follow_up_count, last_follow_up_at, next_follow_up_at, metadata
    ) values (
      ${quote(requestId)}, ${quote(initialAt)}::timestamptz, ${quote(initialAt)}::timestamptz,
      ${quote(`deal-${suffix}`)}, ${quote(`${suffix}@example.test`)}, 'phase-2-admin',
      ${quote(requestStatus)}, ${quote(requestState)}, ${quote(deliveryState)}, ${quote(initialAt)}::timestamptz,
      ${quote(followUpState)}, ${quote(initialAt)}::timestamptz, ${quote(initialAt)}::timestamptz,
      ${quote(submissionId)}::uuid, ${Number(followUpCount)}, null,
      ${nextFollowUpAt ? `${quote(nextFollowUpAt)}::timestamptz` : 'null'}, ${json(metadata)}
    );
  `);
  return { submissionId, requestId, suffix };
}

function getRequest(containerName, database, requestId) {
  return parseJsonResult(psql(
    containerName,
    database,
    `select to_jsonb(request) from public.deal_hunter_cim_requests as request where id = ${quote(requestId)};`,
  ));
}

function activityCount(containerName, database, submissionId) {
  return Number(psql(
    containerName,
    database,
    `select count(*) from public.crm_activity_events where submission_id = ${quote(submissionId)}::uuid;`,
  ).stdout.trim());
}

function startStatement(fixture, {
  marker = canonicalMarker(),
  nextFollowUpAt = firstDueAt,
  activityRecord = activity(fixture.submissionId, enrolledAt, 'cim.manual-follow-ups-enrolled'),
  expectedRequestUpdatedAt = initialAt,
  expectedSubmissionUpdatedAt = initialAt,
} = {}) {
  return `
    select public.start_deal_hunter_manual_follow_ups(
      ${quote(fixture.requestId)}, ${quote(expectedRequestUpdatedAt)}::timestamptz,
      ${quote(fixture.submissionId)}::uuid, ${quote(expectedSubmissionUpdatedAt)}::timestamptz,
      ${json(marker)}, ${quote(nextFollowUpAt)}::timestamptz, ${json(activityRecord)}
    );
  `;
}

function start(containerName, database, fixture, options = {}) {
  return parseJsonResult(psql(containerName, database, startStatement(fixture, options)));
}

function stop(containerName, database, fixture, {
  expectedRequestUpdatedAt,
  stoppedAt = '2026-09-01T18:00:00.000Z',
  stoppedBy = 'storage-admin',
  reason = 'Operator stopped the sequence.',
  activityRecord = activity(fixture.submissionId, stoppedAt, 'cim.manual-follow-ups-stopped'),
} = {}) {
  return parseJsonResult(psql(containerName, database, `
    select public.stop_deal_hunter_manual_follow_ups(
      ${quote(fixture.requestId)}, ${quote(expectedRequestUpdatedAt)}::timestamptz,
      ${quote(fixture.submissionId)}::uuid, ${quote(initialAt)}::timestamptz,
      ${quote(stoppedAt)}::timestamptz, ${quote(stoppedBy)}, ${quote(reason)}, ${json(activityRecord)}
    );
  `));
}

function claimStatement(fixture, {
  expectedRequestUpdatedAt,
  expectedFollowUpCount = 0,
  expectedFollowUpNumber = 1,
  expectedNextFollowUpAt = firstDueAt,
  claimedAt = firstDueAt,
} = {}) {
  return `
    select public.claim_deal_hunter_approved_follow_up(
      ${quote(fixture.requestId)}, ${quote(expectedRequestUpdatedAt)}::timestamptz,
      ${quote(fixture.submissionId)}::uuid, ${quote(initialAt)}::timestamptz,
      ${Number(expectedFollowUpCount)}, ${Number(expectedFollowUpNumber)},
      ${quote(expectedNextFollowUpAt)}::timestamptz, ${quote(claimedAt)}::timestamptz
    );
  `;
}

function claim(containerName, database, fixture, options = {}) {
  return parseJsonResult(psql(containerName, database, claimStatement(fixture, options)));
}

function insertCommunication(containerName, database, fixture, {
  id,
  followUpNumber = 1,
  deliveryState = 'accepted',
  occurredAt = '2026-09-01T17:05:00.000Z',
  providerMessageId = deliveryState === 'accepted' ? `provider-${id}` : null,
  firstProviderAcceptedAt = null,
} = {}) {
  psql(containerName, database, `
    insert into public.crm_communications (
      id, submission_id, deal_key, cim_request_id, direction, channel, source,
      kind, provider, provider_message_id, idempotency_key, from_address,
      to_addresses, subject, body_text, body_html_sanitized, occurred_at,
      created_at, updated_at, delivery_state, delivery_state_at,
      content_state, content_attempt_count, created_by, updated_by, metadata
    ) values (
      ${quote(id)}, ${quote(fixture.submissionId)}::uuid, ${quote(`deal-${fixture.suffix}`)},
      ${quote(fixture.requestId)}, 'outbound', 'email', 'deal-hunter', 'cim-follow-up',
      'resend', ${providerMessageId ? quote(providerMessageId) : 'null'},
      ${quote(`deal-hunter-cim-${fixture.requestId}-follow-up-${followUpNumber}`)}, 'team@example.test',
      ${json([`${fixture.suffix}@example.test`])}, 'Requested materials follow-up',
      ${quote(`Follow-Up ${followUpNumber}`)}, ${quote(`<p>Follow-Up ${followUpNumber}</p>`)},
      ${quote(occurredAt)}::timestamptz, ${quote(occurredAt)}::timestamptz, ${quote(occurredAt)}::timestamptz,
      ${quote(deliveryState)}, ${quote(occurredAt)}::timestamptz, 'complete', 1,
      'storage-admin', 'storage-admin', ${json({
        followUpNumber,
        templateVersion: 'deal-hunter-cim-follow-up-v1',
        ...(firstProviderAcceptedAt ? { manualFollowUp: { firstProviderAcceptedAt } } : {}),
      })}
    );
  `);
}

function writeOutboxProof(containerName, database, fixture, {
  communicationId,
  state,
  occurredAt,
} = {}) {
  psql(containerName, database, `
    insert into public.crm_email_outbox (
      id, communication_id, submission_id, cim_request_id, idempotency_key,
      client_request_key, state, provider, provider_message_id, attempt_count,
      accepted_at, ambiguous_at, expected_submission_version, actor,
      created_at, updated_at, metadata
    ) values (
      ${quote(`outbox-${communicationId}`)}, ${quote(communicationId)}, ${quote(fixture.submissionId)}::uuid,
      ${quote(fixture.requestId)}, ${quote(`outbox-key-${communicationId}`)},
      ${quote(`outbox-client-${communicationId}`)}, ${quote(state)}, 'resend',
      ${state === 'accepted' ? quote(`provider-${communicationId}`) : 'null'}, 1,
      ${state === 'accepted' ? `${quote(occurredAt)}::timestamptz` : 'null'},
      ${state === 'ambiguous' ? `${quote(occurredAt)}::timestamptz` : 'null'},
      ${quote(initialAt)}::timestamptz, 'storage-admin',
      ${quote(occurredAt)}::timestamptz, ${quote(occurredAt)}::timestamptz, '{}'::jsonb
    )
    on conflict (communication_id) do update set
      state = excluded.state,
      provider_message_id = excluded.provider_message_id,
      accepted_at = excluded.accepted_at,
      ambiguous_at = excluded.ambiguous_at,
      updated_at = excluded.updated_at;
  `);
}

function finalizeStatement(fixture, {
  expectedRequestUpdatedAt,
  expectedFollowUpNumber = 1,
  expectedCommunicationId,
  outcome = 'accepted',
  acceptedAt = '2026-09-01T17:05:00.000Z',
  nextFollowUpAt = '2026-09-03T16:00:00.000Z',
  activityRecord = activity(fixture.submissionId, acceptedAt || '2026-09-01T17:05:00.000Z', `cim.follow-up-${outcome}`),
} = {}) {
  return `
    select public.finalize_deal_hunter_approved_follow_up(
      ${quote(fixture.requestId)}, ${quote(expectedRequestUpdatedAt)}::timestamptz,
      ${quote(fixture.submissionId)}::uuid, ${Number(expectedFollowUpNumber)},
      ${quote(expectedCommunicationId)}, ${quote(outcome)},
      ${acceptedAt ? `${quote(acceptedAt)}::timestamptz` : 'null'},
      ${nextFollowUpAt ? `${quote(nextFollowUpAt)}::timestamptz` : 'null'}, ${json(activityRecord)}
    );
  `;
}

function finalize(containerName, database, fixture, options = {}) {
  return parseJsonResult(psql(containerName, database, finalizeStatement(fixture, options)));
}

test('real PostgreSQL enforces Phase 3 Task 2 storage authority and parity', {
  skip: integrationEnabled ? false : 'set DEAL_HUNTER_POSTGRES_INTEGRATION=1 for the required disposable PostgreSQL release gate',
  timeout: 180_000,
}, async (t) => {
  const dockerInfo = docker(['info'], { allowFailure: true });
  assert.equal(dockerInfo.status, 0, `Docker is required for this release gate.\n${dockerInfo.stderr}`);

  const containerName = `uckele-task2-postgres-${process.pid}-${randomUUID().slice(0, 8)}`;
  docker([
    'run', '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=task2-integration-only',
    '-d', 'postgres:16',
  ]);
  t.after(() => docker(['rm', '-f', containerName], { allowFailure: true }));
  waitForPostgres(containerName);

  const schema = fs.readFileSync(schemaPath, 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const parentSchema = execFileSync('git', ['show', `${parentCommit}:supabase/schema.sql`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  psql(containerName, 'postgres', `
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create database task2_fresh;
    create database task2_upgrade;
  `);

  await t.test('fresh schema and parent-schema upgrade both install the four functions', () => {
    psql(containerName, 'task2_fresh', schema);
    psql(containerName, 'task2_upgrade', parentSchema);
    psql(containerName, 'task2_upgrade', migration);
    for (const database of ['task2_fresh', 'task2_upgrade']) {
      const count = Number(psql(containerName, database, `
        select count(*) from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in (
            'start_deal_hunter_manual_follow_ups',
            'stop_deal_hunter_manual_follow_ups',
            'claim_deal_hunter_approved_follow_up',
            'finalize_deal_hunter_approved_follow_up'
          );
      `).stdout.trim());
      assert.equal(count, 4, database);
    }
  });

  const database = 'task2_upgrade';

  await t.test('strict canonical marker rejects malformed and seeded caller authority with zero mutation', () => {
    const canonical = canonicalMarker();
    const invalidMarkers = [
      ['missing-version', Object.fromEntries(Object.entries(canonical).filter(([key]) => key !== 'version'))],
      ['missing-cadence', Object.fromEntries(Object.entries(canonical).filter(([key]) => key !== 'cadencePolicy'))],
      ['string-maximum', { ...canonical, maximumFollowUps: '5' }],
      ['malformed-enrolled-at', { ...canonical, enrolledAt: 'not-an-instant' }],
      ['blank-enrolled-by', { ...canonical, enrolledBy: '   ' }],
      ['seeded-accepted-touches', { ...canonical, acceptedTouches: [{ followUpNumber: 1 }] }],
      ['seeded-stop', { ...canonical, stoppedAt: enrolledAt }],
      ['unknown-field', { ...canonical, callerAuthority: true }],
    ];
    for (const [name, suppliedMarker] of invalidMarkers) {
      const fixture = seedFixture(containerName, database, `strict-${name}`);
      const result = start(containerName, database, fixture, { marker: suppliedMarker });
      assert.equal(result.applied, false, name);
      const unchanged = getRequest(containerName, database, fixture.requestId);
      assert.equal(unchanged.updated_at, '2026-08-28T18:00:00+00:00', name);
      assert.equal(unchanged.follow_up_state, 'not-scheduled', name);
      assert.equal(Object.hasOwn(unchanged.metadata, 'manualFollowUp'), false, name);
      assert.equal(activityCount(containerName, database, fixture.submissionId), 0, name);
    }
  });

  await t.test('canonical marker starts once and partial marker cannot claim', () => {
    const canonicalFixture = seedFixture(containerName, database, 'canonical-start');
    const started = start(containerName, database, canonicalFixture);
    assert.equal(started.applied, true);
    assert.deepEqual(started.request.metadata.manualFollowUp, canonicalMarker());
    assert.equal(activityCount(containerName, database, canonicalFixture.submissionId), 1);

    const partialFixture = seedFixture(containerName, database, 'partial-claim', {
      marker: { mode: 'operator-approved', maximumFollowUps: 5 },
      followUpState: 'scheduled',
      nextFollowUpAt: firstDueAt,
    });
    const partial = claim(containerName, database, partialFixture, { expectedRequestUpdatedAt: initialAt });
    assert.equal(partial.applied, false);
    assert.equal(partial.reason, 'claim-ineligible');
  });

  await t.test('Start stale authority loses and activity failure rolls back the request', () => {
    const staleFixture = seedFixture(containerName, database, 'stale-start');
    const stale = start(containerName, database, staleFixture, {
      expectedRequestUpdatedAt: '2026-08-28T17:59:59.000Z',
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, 'authority-changed');
    assert.equal(getRequest(containerName, database, staleFixture.requestId).follow_up_state, 'not-scheduled');
    assert.equal(activityCount(containerName, database, staleFixture.submissionId), 0);

    const rollbackFixture = seedFixture(containerName, database, 'rollback-start');
    const duplicateActivity = activity(
      rollbackFixture.submissionId,
      enrolledAt,
      'cim.manual-follow-ups-enrolled',
    );
    psql(containerName, database, `
      insert into public.crm_activity_events
      select * from jsonb_populate_record(null::public.crm_activity_events, ${json(duplicateActivity)});
    `);
    const failed = psql(
      containerName,
      database,
      startStatement(rollbackFixture, { activityRecord: duplicateActivity }),
      { allowFailure: true },
    );
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /duplicate key/i);
    const unchanged = getRequest(containerName, database, rollbackFixture.requestId);
    assert.equal(unchanged.updated_at, '2026-08-28T18:00:00+00:00');
    assert.equal(unchanged.follow_up_state, 'not-scheduled');
    assert.equal(Object.hasOwn(unchanged.metadata, 'manualFollowUp'), false);
    assert.equal(activityCount(containerName, database, rollbackFixture.submissionId), 1);
  });

  await t.test('concurrent PostgreSQL Start claim and accepted finalization have one winner', async () => {
    psql(containerName, database, `
      create or replace function public.task2_test_hold_request_update()
      returns trigger language plpgsql as $$
      begin
        if new.id like 'pg-concurrent-%' then perform pg_sleep(0.2); end if;
        return new;
      end;
      $$;
      create trigger task2_test_hold_request_update
      before update on public.deal_hunter_cim_requests
      for each row execute function public.task2_test_hold_request_update();
    `);
    try {
      const fixture = seedFixture(containerName, database, 'concurrent-sequence');
      const startActivity = activity(fixture.submissionId, enrolledAt, 'cim.manual-follow-ups-enrolled');
      const startResults = await Promise.all([
        psqlAsync(containerName, database, startStatement(fixture, { activityRecord: startActivity })),
        psqlAsync(containerName, database, startStatement(fixture, { activityRecord: startActivity })),
      ]);
      assert.equal(new Set(startResults.map(({ pid }) => pid)).size, 2);
      assert.deepEqual(startResults.map(({ status }) => status), [0, 0]);
      const starts = startResults.map(parseJsonResult);
      assert.equal(starts.filter(({ applied }) => applied).length, 1);
      assert.equal(activityCount(containerName, database, fixture.submissionId), 1);
      const started = getRequest(containerName, database, fixture.requestId);

      const claimOptions = { expectedRequestUpdatedAt: started.updated_at };
      const claimResults = await Promise.all([
        psqlAsync(containerName, database, claimStatement(fixture, claimOptions)),
        psqlAsync(containerName, database, claimStatement(fixture, claimOptions)),
      ]);
      assert.deepEqual(claimResults.map(({ status }) => status), [0, 0]);
      const claims = claimResults.map(parseJsonResult);
      assert.equal(claims.filter(({ applied }) => applied).length, 1);
      const claimed = getRequest(containerName, database, fixture.requestId);

      const acceptedAt = '2026-09-01T17:05:00.000Z';
      const communicationId = deterministicCommunicationId(fixture.requestId, 1);
      insertCommunication(containerName, database, fixture, { id: communicationId, occurredAt: acceptedAt });
      const acceptedActivity = activity(fixture.submissionId, acceptedAt, 'cim.follow-up-accepted');
      const finalizeOptions = {
        expectedRequestUpdatedAt: claimed.updated_at,
        expectedCommunicationId: communicationId,
        acceptedAt,
        nextFollowUpAt: '2026-09-03T16:00:00.000Z',
        activityRecord: acceptedActivity,
      };
      const finalizeResults = await Promise.all([
        psqlAsync(containerName, database, finalizeStatement(fixture, finalizeOptions)),
        psqlAsync(containerName, database, finalizeStatement(fixture, finalizeOptions)),
      ]);
      assert.deepEqual(finalizeResults.map(({ status }) => status), [0, 0]);
      const finalizations = finalizeResults.map(parseJsonResult);
      assert.equal(finalizations.filter(({ applied }) => applied).length, 1);
      assert.equal(finalizations.filter(({ alreadyFinalized }) => alreadyFinalized).length, 1);
      const accepted = getRequest(containerName, database, fixture.requestId);
      assert.equal(accepted.follow_up_count, 1);
      assert.equal(accepted.metadata.manualFollowUp.acceptedTouches.length, 1);
      assert.equal(activityCount(containerName, database, fixture.submissionId), 2);
    } finally {
      psql(containerName, database, `
        drop trigger if exists task2_test_hold_request_update on public.deal_hunter_cim_requests;
        drop function if exists public.task2_test_hold_request_update();
      `);
    }
  });

  await t.test('wrong communication ID and wrong cadence assertion leave accepted state unchanged', () => {
    const wrongIdFixture = seedFixture(containerName, database, 'wrong-id');
    const started = start(containerName, database, wrongIdFixture);
    const claimed = claim(containerName, database, wrongIdFixture, { expectedRequestUpdatedAt: started.request.updated_at });
    const wrongId = 'not-the-deterministic-sha256-identity';
    insertCommunication(containerName, database, wrongIdFixture, { id: wrongId });
    const wrongIdentity = finalize(containerName, database, wrongIdFixture, {
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedCommunicationId: wrongId,
    });
    assert.equal(wrongIdentity.applied, false);
    assert.equal(wrongIdentity.reason, 'finalize-ineligible');
    assert.equal(getRequest(containerName, database, wrongIdFixture.requestId).follow_up_count, 0);
    assert.equal(activityCount(containerName, database, wrongIdFixture.submissionId), 1);

    const wrongDueFixture = seedFixture(containerName, database, 'wrong-due');
    const dueStarted = start(containerName, database, wrongDueFixture);
    const dueClaimed = claim(containerName, database, wrongDueFixture, { expectedRequestUpdatedAt: dueStarted.request.updated_at });
    const canonicalId = deterministicCommunicationId(wrongDueFixture.requestId, 1);
    insertCommunication(containerName, database, wrongDueFixture, {
      id: canonicalId,
      occurredAt: '2026-09-03T23:37:00.000Z',
    });
    const wrongDue = finalize(containerName, database, wrongDueFixture, {
      expectedRequestUpdatedAt: dueClaimed.request.updated_at,
      expectedCommunicationId: canonicalId,
      acceptedAt: '2026-09-03T23:37:00.000Z',
      nextFollowUpAt: '2026-09-07T17:00:00.000Z',
    });
    assert.equal(wrongDue.applied, false);
    assert.equal(getRequest(containerName, database, wrongDueFixture.requestId).follow_up_count, 0);
  });

  await t.test('canonical accepted finalization derives Thursday Friday and DST cadence and replays once', () => {
    const cases = [
      ['thursday', '2026-09-03T23:37:00.000Z', '2026-09-07T16:00:00.000Z'],
      ['friday', '2026-09-04T20:00:00.000Z', '2026-09-07T16:00:00.000Z'],
      ['spring-dst', '2026-03-06T20:00:00.000Z', '2026-03-09T16:00:00.000Z'],
      ['fall-dst', '2026-10-30T20:00:00.000Z', '2026-11-02T17:00:00.000Z'],
    ];
    for (const [name, acceptedAt, dueAt] of cases) {
      const fixture = seedFixture(containerName, database, `cadence-${name}`);
      const started = start(containerName, database, fixture);
      const claimed = claim(containerName, database, fixture, { expectedRequestUpdatedAt: started.request.updated_at });
      const communicationId = deterministicCommunicationId(fixture.requestId, 1);
      insertCommunication(containerName, database, fixture, { id: communicationId, occurredAt: acceptedAt });
      const acceptedActivity = activity(fixture.submissionId, acceptedAt, 'cim.follow-up-accepted');
      const accepted = finalize(containerName, database, fixture, {
        expectedRequestUpdatedAt: claimed.request.updated_at,
        expectedCommunicationId: communicationId,
        acceptedAt,
        nextFollowUpAt: dueAt,
        activityRecord: acceptedActivity,
      });
      const replay = finalize(containerName, database, fixture, {
        expectedRequestUpdatedAt: claimed.request.updated_at,
        expectedCommunicationId: communicationId,
        acceptedAt,
        nextFollowUpAt: dueAt,
        activityRecord: acceptedActivity,
      });
      assert.equal(accepted.applied, true, name);
      assert.equal(accepted.request.follow_up_count, 1, name);
      assert.equal(accepted.request.last_follow_up_at, acceptedAt.replace('.000Z', '+00:00'), name);
      assert.equal(accepted.request.next_follow_up_at, dueAt.replace('.000Z', '+00:00'), name);
      assert.equal(replay.alreadyFinalized, true, name);
      assert.equal(activityCount(containerName, database, fixture.submissionId), 2, name);
    }
  });

  await t.test('later provider lifecycle states retain the original accepted instant and terminal scheduling semantics', () => {
    const acceptedAt = '2026-09-01T17:05:00.000Z';
    const laterAt = '2026-09-01T18:05:00.000Z';
    const dueAt = '2026-09-03T16:00:00.000Z';
    for (const deliveryState of ['delivered', 'delayed', 'bounced', 'complained', 'suppressed']) {
      const fixture = seedFixture(containerName, database, `accepted-then-${deliveryState}`);
      const started = start(containerName, database, fixture);
      const claimed = claim(containerName, database, fixture, { expectedRequestUpdatedAt: started.request.updated_at });
      const communicationId = deterministicCommunicationId(fixture.requestId, 1);
      insertCommunication(containerName, database, fixture, {
        id: communicationId,
        deliveryState,
        occurredAt: laterAt,
        providerMessageId: `provider-${communicationId}`,
        firstProviderAcceptedAt: acceptedAt,
      });
      const terminalDelivery = ['bounced', 'complained', 'suppressed'].includes(deliveryState);
      psql(containerName, database, `
        update public.deal_hunter_cim_requests set
          status = ${quote(terminalDelivery ? 'delivery_issue' : 'follow_up_pending')},
          delivery_state = ${quote(deliveryState)},
          delivery_state_at = ${quote(laterAt)}::timestamptz
        where id = ${quote(fixture.requestId)};
      `);
      const accepted = finalize(containerName, database, fixture, {
        expectedRequestUpdatedAt: claimed.request.updated_at,
        expectedCommunicationId: communicationId,
        acceptedAt,
        nextFollowUpAt: dueAt,
      });
      assert.equal(accepted.applied, true, deliveryState);
      assert.equal(accepted.request.follow_up_count, 1, deliveryState);
      assert.equal(accepted.request.last_follow_up_at, acceptedAt.replace('.000Z', '+00:00'), deliveryState);
      assert.equal(normalizedTimestamp(accepted.request.metadata.manualFollowUp.acceptedTouches[0].acceptedAt), acceptedAt, deliveryState);
      if (terminalDelivery) {
        assert.equal(accepted.request.follow_up_state, 'stopped', deliveryState);
        assert.equal(accepted.request.next_follow_up_at, null, deliveryState);
      } else {
        assert.equal(accepted.request.follow_up_state, 'scheduled', deliveryState);
        assert.equal(accepted.request.next_follow_up_at, dueAt.replace('.000Z', '+00:00'), deliveryState);
      }
    }
  });

  await t.test('claim accepts only the current due logical N and rejects stopped or count-five requests', () => {
    const fixture = seedFixture(containerName, database, 'claim-contract');
    const started = start(containerName, database, fixture);
    const wrongNumber = claim(containerName, database, fixture, {
      expectedRequestUpdatedAt: started.request.updated_at,
      expectedFollowUpNumber: 2,
    });
    assert.equal(wrongNumber.applied, false);
    assert.equal(wrongNumber.reason, 'claim-ineligible');
    const correct = claim(containerName, database, fixture, { expectedRequestUpdatedAt: started.request.updated_at });
    assert.equal(correct.applied, true);

    const stoppedFixture = seedFixture(containerName, database, 'claim-stopped');
    const stopStarted = start(containerName, database, stoppedFixture);
    const stopped = stop(containerName, database, stoppedFixture, {
      expectedRequestUpdatedAt: stopStarted.request.updated_at,
    });
    assert.equal(stopped.applied, true);
    const stoppedClaim = claim(containerName, database, stoppedFixture, {
      expectedRequestUpdatedAt: stopped.request.updated_at,
    });
    assert.equal(stoppedClaim.applied, false);

    const completedFixture = seedFixture(containerName, database, 'claim-count-five', {
      followUpCount: 5,
      followUpState: 'completed',
      marker: canonicalMarker(),
    });
    const completedClaim = claim(containerName, database, completedFixture, {
      expectedRequestUpdatedAt: initialAt,
      expectedFollowUpCount: 5,
      expectedFollowUpNumber: 5,
    });
    assert.equal(completedClaim.applied, false);
  });

  await t.test('definitive failure retains count identity and due without an accepted ledger', () => {
    const fixture = seedFixture(containerName, database, 'definitive-failure');
    const started = start(containerName, database, fixture);
    const claimed = claim(containerName, database, fixture, { expectedRequestUpdatedAt: started.request.updated_at });
    const communicationId = deterministicCommunicationId(fixture.requestId, 1);
    const failedAt = '2026-09-01T17:05:00.000Z';
    insertCommunication(containerName, database, fixture, {
      id: communicationId,
      deliveryState: 'failed',
      occurredAt: failedAt,
    });
    const failureActivity = activity(fixture.submissionId, failedAt, 'cim.follow-up-failed');
    const failed = finalize(containerName, database, fixture, {
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedCommunicationId: communicationId,
      outcome: 'definitive-failure',
      acceptedAt: null,
      nextFollowUpAt: null,
      activityRecord: failureActivity,
    });
    const replay = finalize(containerName, database, fixture, {
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedCommunicationId: communicationId,
      outcome: 'definitive-failure',
      acceptedAt: null,
      nextFollowUpAt: null,
      activityRecord: failureActivity,
    });
    assert.equal(failed.applied, true);
    assert.equal(failed.request.follow_up_count, 0);
    assert.equal(failed.request.follow_up_state, 'failed');
    assert.equal(failed.request.next_follow_up_at, '2026-09-01T17:00:00+00:00');
    assert.deepEqual(failed.request.metadata.manualFollowUp.acceptedTouches || [], []);
    assert.equal(replay.alreadyFinalized, true);
    assert.equal(activityCount(containerName, database, fixture.submissionId), 2);
  });

  await t.test('Follow-Up 5 completes and replay never schedules Follow-Up 6', () => {
    const fixture = seedFixture(containerName, database, 'follow-up-five', { followUpCount: 4 });
    const started = start(containerName, database, fixture);
    const claimed = claim(containerName, database, fixture, {
      expectedRequestUpdatedAt: started.request.updated_at,
      expectedFollowUpCount: 4,
      expectedFollowUpNumber: 5,
    });
    assert.equal(claimed.applied, true);
    const communicationId = deterministicCommunicationId(fixture.requestId, 5);
    const acceptedAt = '2026-09-04T20:00:00.000Z';
    insertCommunication(containerName, database, fixture, {
      id: communicationId,
      followUpNumber: 5,
      occurredAt: acceptedAt,
    });
    const acceptedActivity = activity(fixture.submissionId, acceptedAt, 'cim.follow-up-accepted');
    const options = {
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedFollowUpNumber: 5,
      expectedCommunicationId: communicationId,
      acceptedAt,
      nextFollowUpAt: null,
      activityRecord: acceptedActivity,
    };
    const accepted = finalize(containerName, database, fixture, options);
    const replay = finalize(containerName, database, fixture, options);
    assert.equal(accepted.applied, true);
    assert.equal(accepted.request.follow_up_count, 5);
    assert.equal(accepted.request.follow_up_state, 'completed');
    assert.equal(accepted.request.next_follow_up_at, null);
    assert.equal(replay.alreadyFinalized, true);
    assert.equal(activityCount(containerName, database, fixture.submissionId), 2);
  });

  await t.test('accepted reconciliation after Stop records truth and never recreates a schedule', () => {
    const fixture = seedFixture(containerName, database, 'stopped-reconciliation');
    const started = start(containerName, database, fixture);
    const claimed = claim(containerName, database, fixture, { expectedRequestUpdatedAt: started.request.updated_at });
    const communicationId = deterministicCommunicationId(fixture.requestId, 1);
    const acceptedAt = '2026-09-01T17:05:00.000Z';
    insertCommunication(containerName, database, fixture, { id: communicationId, occurredAt: acceptedAt });
    const stopped = stop(containerName, database, fixture, {
      expectedRequestUpdatedAt: claimed.request.updated_at,
      stoppedAt: '2026-09-01T17:04:00.000Z',
    });
    assert.equal(stopped.applied, true);
    const accepted = finalize(containerName, database, fixture, {
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedCommunicationId: communicationId,
      acceptedAt,
      nextFollowUpAt: '2026-09-03T16:00:00.000Z',
      activityRecord: activity(fixture.submissionId, acceptedAt, 'cim.follow-up-accepted'),
    });
    assert.equal(accepted.applied, true);
    assert.equal(accepted.request.follow_up_count, 1);
    assert.equal(accepted.request.follow_up_state, 'stopped');
    assert.equal(accepted.request.next_follow_up_at, null);
    assert.equal(accepted.request.metadata.manualFollowUp.acceptedTouches.length, 1);
    assert.equal(activityCount(containerName, database, fixture.submissionId), 3);
  });

  await t.test('outbox ambiguity proof clears schedule and later accepted reconciliation counts once', () => {
    const fixture = seedFixture(containerName, database, 'ambiguous');
    const started = start(containerName, database, fixture);
    const claimed = claim(containerName, database, fixture, { expectedRequestUpdatedAt: started.request.updated_at });
    const communicationId = deterministicCommunicationId(fixture.requestId, 1);
    const ambiguousAt = '2026-09-01T17:05:00.000Z';
    insertCommunication(containerName, database, fixture, {
      id: communicationId,
      deliveryState: 'not-attempted',
      occurredAt: ambiguousAt,
    });
    writeOutboxProof(containerName, database, fixture, { communicationId, state: 'ambiguous', occurredAt: ambiguousAt });
    const ambiguous = finalize(containerName, database, fixture, {
      expectedRequestUpdatedAt: claimed.request.updated_at,
      expectedCommunicationId: communicationId,
      outcome: 'ambiguous',
      acceptedAt: null,
      nextFollowUpAt: null,
      activityRecord: activity(fixture.submissionId, ambiguousAt, 'cim.follow-up-ambiguous'),
    });
    assert.equal(ambiguous.applied, true);
    assert.equal(ambiguous.request.follow_up_count, 0);
    assert.equal(ambiguous.request.follow_up_state, 'ambiguous');
    assert.equal(ambiguous.request.next_follow_up_at, null);
    assert.deepEqual(ambiguous.request.metadata.manualFollowUp.acceptedTouches || [], []);

    const acceptedAt = '2026-09-01T17:06:00.000Z';
    psql(containerName, database, `
      update public.crm_communications set
        provider_message_id = ${quote(`provider-${communicationId}`)},
        delivery_state = 'accepted', delivery_state_at = ${quote(acceptedAt)}::timestamptz,
        updated_at = ${quote(acceptedAt)}::timestamptz
      where id = ${quote(communicationId)};
    `);
    writeOutboxProof(containerName, database, fixture, { communicationId, state: 'accepted', occurredAt: acceptedAt });
    const acceptedActivity = activity(fixture.submissionId, acceptedAt, 'cim.follow-up-accepted');
    const reconciled = finalize(containerName, database, fixture, {
      expectedRequestUpdatedAt: ambiguous.request.updated_at,
      expectedCommunicationId: communicationId,
      acceptedAt,
      nextFollowUpAt: '2026-09-03T16:00:00.000Z',
      activityRecord: acceptedActivity,
    });
    const replay = finalize(containerName, database, fixture, {
      expectedRequestUpdatedAt: ambiguous.request.updated_at,
      expectedCommunicationId: communicationId,
      acceptedAt,
      nextFollowUpAt: '2026-09-03T16:00:00.000Z',
      activityRecord: acceptedActivity,
    });
    assert.equal(reconciled.applied, true);
    assert.equal(reconciled.request.follow_up_count, 1);
    assert.equal(reconciled.request.follow_up_state, 'scheduled');
    assert.equal(replay.alreadyFinalized, true);
    assert.equal(activityCount(containerName, database, fixture.submissionId), 3);
  });

  await t.test('Stop normalizes and truncates its reason to exactly 240 characters', () => {
    const fixture = seedFixture(containerName, database, 'stop-bound');
    const started = start(containerName, database, fixture);
    const longReason = `  ${'operator \n requested\t stop   '.repeat(40)}  `;
    const stopped = stop(containerName, database, fixture, {
      expectedRequestUpdatedAt: started.request.updated_at,
      reason: longReason,
    });
    const expected = 'operator requested stop operator requested stop operator requested stop operator requested stop operator requested stop '
      + 'operator requested stop operator requested stop operator requested stop operator requested stop operator requested stop ';
    assert.equal(stopped.applied, true);
    assert.equal(stopped.request.metadata.manualFollowUp.stopReason, expected);
    assert.equal(stopped.request.metadata.manualFollowUp.stopReason.length, 240);
    assert.equal(stopped.request.follow_up_count, 0);
    assert.equal(stopped.request.next_follow_up_at, null);
    const duplicate = stop(containerName, database, fixture, {
      expectedRequestUpdatedAt: stopped.request.updated_at,
      reason: longReason,
    });
    assert.equal(duplicate.applied, false);
    assert.equal(duplicate.reason, 'not-eligible');
    const stale = stop(containerName, database, fixture, {
      expectedRequestUpdatedAt: started.request.updated_at,
      reason: longReason,
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, 'authority-changed');
    assert.equal(activityCount(containerName, database, fixture.submissionId), 2);
  });

  await t.test('normalized SQLite and real PostgreSQL core outcomes match', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-task2-postgres-parity-'));
    const sqlite = createSqliteStorage({
      storage: { sqlitePath: path.join(tempDir, 'crm.sqlite') },
      protection: { rateLimitRetentionMs: 0 },
    });
    try {
      const fixture = seedFixture(containerName, database, 'real-provider-parity');
      await seedSqliteParityFixture(sqlite, fixture);

      const invalidMarker = canonicalMarker();
      delete invalidMarker.version;
      const invalidActivity = activity(
        fixture.submissionId,
        enrolledAt,
        'cim.manual-follow-ups-enrolled',
      );
      const postgresInvalid = start(containerName, database, fixture, {
        marker: invalidMarker,
        activityRecord: invalidActivity,
      });
      const sqliteInvalid = await sqlite.startDealHunterManualFollowUps({
        requestId: fixture.requestId,
        expectedRequestUpdatedAt: initialAt,
        expectedSubmissionId: fixture.submissionId,
        expectedSubmissionUpdatedAt: initialAt,
        marker: invalidMarker,
        nextFollowUpAt: firstDueAt,
        activity: invalidActivity,
      });
      assert.deepEqual(normalizedCoreResult(postgresInvalid), normalizedCoreResult(sqliteInvalid));

      const startActivity = activity(
        fixture.submissionId,
        enrolledAt,
        'cim.manual-follow-ups-enrolled',
      );
      const postgresStart = start(containerName, database, fixture, { activityRecord: startActivity });
      const sqliteStart = await sqlite.startDealHunterManualFollowUps({
        requestId: fixture.requestId,
        expectedRequestUpdatedAt: initialAt,
        expectedSubmissionId: fixture.submissionId,
        expectedSubmissionUpdatedAt: initialAt,
        marker: canonicalMarker(),
        nextFollowUpAt: firstDueAt,
        activity: startActivity,
      });
      assert.deepEqual(normalizedCoreResult(postgresStart), normalizedCoreResult(sqliteStart));

      const postgresClaim = claim(containerName, database, fixture, {
        expectedRequestUpdatedAt: postgresStart.request.updated_at,
      });
      const sqliteClaim = await sqlite.claimDealHunterApprovedFollowUp({
        requestId: fixture.requestId,
        expectedRequestUpdatedAt: sqliteStart.request.updated_at,
        expectedSubmissionId: fixture.submissionId,
        expectedSubmissionUpdatedAt: initialAt,
        expectedFollowUpCount: 0,
        expectedFollowUpNumber: 1,
        expectedNextFollowUpAt: firstDueAt,
        claimedAt: firstDueAt,
      });
      assert.deepEqual(normalizedCoreResult(postgresClaim), normalizedCoreResult(sqliteClaim));

      const acceptedAt = '2026-09-03T23:37:00.000Z';
      const dueAt = '2026-09-07T16:00:00.000Z';
      const communicationId = deterministicCommunicationId(fixture.requestId, 1);
      insertCommunication(containerName, database, fixture, { id: communicationId, occurredAt: acceptedAt });
      await sqlite.insertCrmCommunication(sqliteCommunication(fixture, {
        id: communicationId,
        occurredAt: acceptedAt,
      }));
      const acceptedActivity = activity(
        fixture.submissionId,
        acceptedAt,
        'cim.follow-up-accepted',
      );
      const postgresFinalizeOptions = {
        expectedRequestUpdatedAt: postgresClaim.request.updated_at,
        expectedCommunicationId: communicationId,
        acceptedAt,
        nextFollowUpAt: dueAt,
        activityRecord: acceptedActivity,
      };
      const postgresAccepted = finalize(containerName, database, fixture, postgresFinalizeOptions);
      const sqliteFinalizeInput = {
        requestId: fixture.requestId,
        expectedRequestUpdatedAt: sqliteClaim.request.updated_at,
        expectedSubmissionId: fixture.submissionId,
        expectedFollowUpNumber: 1,
        expectedCommunicationId: communicationId,
        outcome: 'accepted',
        acceptedAt,
        nextFollowUpAt: dueAt,
        activity: acceptedActivity,
      };
      const sqliteAccepted = await sqlite.finalizeDealHunterApprovedFollowUp(sqliteFinalizeInput);
      assert.deepEqual(normalizedCoreResult(postgresAccepted), normalizedCoreResult(sqliteAccepted));

      const postgresReplay = finalize(containerName, database, fixture, postgresFinalizeOptions);
      const sqliteReplay = await sqlite.finalizeDealHunterApprovedFollowUp(sqliteFinalizeInput);
      assert.deepEqual(normalizedCoreResult(postgresReplay), normalizedCoreResult(sqliteReplay));

      const stoppedAt = '2026-09-07T18:00:00.000Z';
      const stopActivity = activity(
        fixture.submissionId,
        stoppedAt,
        'cim.manual-follow-ups-stopped',
      );
      const postgresStop = stop(containerName, database, fixture, {
        expectedRequestUpdatedAt: postgresAccepted.request.updated_at,
        stoppedAt,
        reason: 'Provider parity stop.',
        activityRecord: stopActivity,
      });
      const sqliteStop = await sqlite.stopDealHunterManualFollowUps({
        requestId: fixture.requestId,
        expectedRequestUpdatedAt: sqliteAccepted.request.updated_at,
        expectedSubmissionId: fixture.submissionId,
        expectedSubmissionUpdatedAt: initialAt,
        stoppedAt,
        stoppedBy: 'storage-admin',
        reason: 'Provider parity stop.',
        activity: stopActivity,
      });
      assert.deepEqual(normalizedCoreResult(postgresStop), normalizedCoreResult(sqliteStop));
    } finally {
      sqlite.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('RPC execution privileges are service-role only', () => {
    const publicExecuteCount = Number(psql(containerName, database, `
      select count(*)
      from pg_proc as procedure
      cross join lateral aclexplode(coalesce(
        procedure.proacl,
        acldefault('f', procedure.proowner)
      )) as privilege
      where procedure.pronamespace = 'public'::regnamespace
        and procedure.proname in (
          'start_deal_hunter_manual_follow_ups',
          'stop_deal_hunter_manual_follow_ups',
          'claim_deal_hunter_approved_follow_up',
          'finalize_deal_hunter_approved_follow_up'
        )
        and privilege.grantee = 0
        and privilege.privilege_type = 'EXECUTE';
    `).stdout.trim());
    assert.equal(publicExecuteCount, 0);
    const service = psql(containerName, database, `
      set role service_role;
      select public.start_deal_hunter_manual_follow_ups(
        'missing-request', ${quote(initialAt)}::timestamptz,
        '00000000-0000-4000-8000-999999999999'::uuid, ${quote(initialAt)}::timestamptz,
        ${json(canonicalMarker())}, ${quote(firstDueAt)}::timestamptz,
        ${json(activity('00000000-0000-4000-8000-999999999999', enrolledAt, 'cim.manual-follow-ups-enrolled'))}
      );
    `);
    assert.equal(parseJsonResult(service).reason, 'request-missing');
    for (const role of ['anon', 'authenticated']) {
      const denied = psql(containerName, database, `
        set role ${role};
        select public.start_deal_hunter_manual_follow_ups(
          'missing-request', ${quote(initialAt)}::timestamptz,
          '00000000-0000-4000-8000-999999999999'::uuid, ${quote(initialAt)}::timestamptz,
          ${json(canonicalMarker())}, ${quote(firstDueAt)}::timestamptz,
          ${json(activity('00000000-0000-4000-8000-999999999999', enrolledAt, 'cim.manual-follow-ups-enrolled'))}
        );
      `, { allowFailure: true });
      assert.notEqual(denied.status, 0, role);
      assert.match(denied.stderr, /permission denied/i, role);
    }
  });
});
