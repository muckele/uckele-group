import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signPayload } from '../server/utils/security.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-app-'));
process.env.ADMIN_SESSION_SECRET = 'http-app-session-secret-for-tests';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-app-document-secret-for-tests';
process.env.SQLITE_PATH = path.join(tempDir, 'http-app.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH = path.join(tempDir, 'task-four-source-health.json');
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
process.env.DEAL_HUNTER_CRON_SECRET = 'task-three-cron-secret';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const appModule = await import('../server/app.js');
const { createApp } = appModule;
const { getConfig } = await import('../server/config.js');
const { buildEmailReadiness } = await import('../server/services/emailReadiness.js');
const { createSecureUploadRequest } = await import('../server/services/documentVault.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { getStorage } = await import('../server/storage/index.js');
let lifecycleAdminCookie = '';
let lifecycleViewerCookie = '';
let taskThreeAdminCookie = '';
let taskThreeViewerCookie = '';

async function withServer(run, app = createApp()) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postChunked(url, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.write(body);
    request.end();
  });
}

async function signInForCookie(_origin, credentials = { username: 'admin', password: 'change-me-now' }) {
  const isViewer = credentials.username === 'smb-deal-hunter';
  const cached = isViewer ? taskThreeViewerCookie : taskThreeAdminCookie;
  if (cached) return cached;
  const now = new Date();
  const session = {
    id: randomUUID(),
    role: isViewer ? 'viewer' : 'admin',
    username: credentials.username,
    principal_id: isViewer ? `viewer:identity:${credentials.username}` : 'admin:primary',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    last_seen_at: now.toISOString(),
    revoked_at: null,
    created_ip_hash: null,
    user_agent: 'task-three-http-test',
    metadata: { auth_method: 'test-fixture' },
  };
  await getStorage().insertAdminSession(session);
  const token = signPayload({
    sid: session.id,
    role: session.role,
    username: session.username,
    exp: Date.parse(session.expires_at),
  }, process.env.ADMIN_SESSION_SECRET);
  const cookie = `ug_admin_session=${token}`;
  if (isViewer) taskThreeViewerCookie = cookie;
  else taskThreeAdminCookie = cookie;
  return cookie;
}

function writeTaskFourSourceSnapshot({ requiredHealthy = true, optionalWarning = false } = {}) {
  const now = new Date();
  const issues = requiredHealthy ? [] : [{
    sourceId: 'sheet-0', affectsHealth: true, sourceUnavailable: true,
    title: 'Required source unavailable', message: 'Private source diagnostic must not be returned.',
  }];
  const exportedAt = optionalWarning ? new Date(now.getTime() - 73 * 60 * 60 * 1000).toISOString() : now.toISOString();
  fs.writeFileSync(process.env.ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH, JSON.stringify({
    generatedAt: now.toISOString(),
    issues,
    totals: { reviewedDeals: 1 },
    sources: {
      'sheet-0': {
        rowCount: 1, name: 'SMB Deal Hunter Google Sheet', mode: 'csv', required: true,
        sourceRole: 'required-primary', checkedAt: now.toISOString(),
      },
      'deal-os-export': {
        rowCount: 1, name: 'SMB Deal OS export', mode: 'manual-export', required: false,
        sourceRole: 'optional-supplemental', checkedAt: now.toISOString(), exportedAt, maxAgeHours: 72,
      },
    },
  }));
}

async function seedTaskFourOpportunity(opportunityId) {
  const storage = getStorage();
  const now = new Date().toISOString();
  await storage.upsertDealHunterOpportunity({
    opportunity_id: opportunityId, created_at: now, updated_at: now,
    canonical_name: 'Task Four HTTP Authority', canonical_recipient: null, canonical_location: 'Los Angeles, CA',
    primary_submission_id: null, identity_version: 'task-four-http', status: 'active', metadata: {},
  });
  await storage.writeDealHunterOpportunityScore({
    opportunity_id: opportunityId, scored_at: now, deal_key: `deal-${opportunityId}`,
    name: 'Task Four HTTP Authority', state: 'CA', listing_url: 'https://broker.example/task-four',
    fit_score: 82, score_status: 'high-fit', confidence: 'high', completeness_score: 90,
    contradiction_count: 0, missing_evidence_count: 0, should_remove: false, high_fit: true, gate_count: 0,
    score_fingerprint: `fingerprint-${opportunityId}`, semantic_digest: `digest-${opportunityId}`,
    engine_version: 'task-four-http', rules_version: 'task-four-http', profile_version: 'task-four-http',
    completeness_policy_version: 'task-four-http', dimensions: [], gates: [], applied_caps: [], missing_evidence: [],
    confidence_reasons: [], summary: { strengths: ['Current primary authority'], concerns: ['Needs operator review'] },
  }, []);
  await storage.reconcileDealHunterCurrentScoreEligibility([opportunityId]);
  return storage;
}

async function withEmailReadinessAddressConfig({
  adminEmail,
  fallbackRecipient,
  dealHunterRecipient,
  fromAddress,
  replyToAddress,
  followUpSenderAddress,
  followUpReplyToAddress,
}, run) {
  const config = getConfig();
  const original = {
    adminEmail: config.admin.email,
    fallbackRecipient: config.delivery.fallbackRecipient,
    dealHunterRecipient: config.dealHunter.recipient,
    deliveryProvider: config.delivery.provider,
    resendApiKey: config.delivery.resendApiKey,
    resendFromEmail: config.delivery.resendFromEmail,
    resendReplyTo: config.delivery.resendReplyTo,
    resendInboundDomain: config.delivery.resendInboundDomain,
    emailWebhookSecret: config.delivery.emailWebhookSecret,
    followUpSenderEmail: config.followUp.senderEmail,
    followUpReplyTo: config.followUp.replyTo,
  };

  config.admin.email = adminEmail;
  config.delivery.fallbackRecipient = fallbackRecipient;
  config.dealHunter.recipient = dealHunterRecipient;
  config.delivery.provider = 'resend';
  config.delivery.resendApiKey = 're_browser_readiness_fixture';
  config.delivery.resendFromEmail = fromAddress;
  config.delivery.resendReplyTo = replyToAddress;
  config.delivery.resendInboundDomain = replyToAddress.split('@')[1];
  config.delivery.emailWebhookSecret = 'browser-readiness-webhook-fixture';
  config.followUp.senderEmail = followUpSenderAddress;
  config.followUp.replyTo = followUpReplyToAddress;

  try {
    await run(config);
  } finally {
    config.admin.email = original.adminEmail;
    config.delivery.fallbackRecipient = original.fallbackRecipient;
    config.dealHunter.recipient = original.dealHunterRecipient;
    config.delivery.provider = original.deliveryProvider;
    config.delivery.resendApiKey = original.resendApiKey;
    config.delivery.resendFromEmail = original.resendFromEmail;
    config.delivery.resendReplyTo = original.resendReplyTo;
    config.delivery.resendInboundDomain = original.resendInboundDomain;
    config.delivery.emailWebhookSecret = original.emailWebhookSecret;
    config.followUp.senderEmail = original.followUpSenderEmail;
    config.followUp.replyTo = original.followUpReplyTo;
  }
}

test('protected APIs reject cross-site mutations and disable caching', async () => {
  await withServer(async (origin) => {
    const sessionResponse = await fetch(`${origin}/api/admin/session`);
    assert.equal(sessionResponse.status, 200);
    assert.match(sessionResponse.headers.get('cache-control') || '', /no-store/);

    const crossSiteResponse = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(crossSiteResponse.status, 403);
    assert.deepEqual(await crossSiteResponse.json(), {
      success: false,
      error: 'Cross-site request rejected.',
    });
  });
});

test('malformed session cookies are treated as anonymous instead of crashing', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/session`, {
      headers: { Cookie: 'ug_admin_session=%E0%A4%A' },
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.authenticated, false);
  });
});

test('bodyless public and admin posts return controlled client errors', async () => {
  await withServer(async (origin) => {
    const contactResponse = await fetch(`${origin}/api/contact`, { method: 'POST' });
    const contactResult = await contactResponse.json();
    assert.equal(contactResponse.status, 400);
    assert.equal(contactResult.success, false);
    assert.ok(Array.isArray(contactResult.errors));

    const loginResponse = await fetch(`${origin}/api/admin/session`, { method: 'POST' });
    const loginResult = await loginResponse.json();
    assert.equal(loginResponse.status, 401);
    assert.deepEqual(loginResult, { success: false, error: 'Invalid credentials.' });
  });
});

test('public analytics endpoint accepts an allowlisted event without retaining sensitive request details', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/analytics/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Fly-Client-Ip': '203.0.113.19',
      },
      body: JSON.stringify({
        eventName: 'criteria_downloaded',
        path: '/criteria',
        placement: 'criteria_page',
        attribution: {
          referrerHost: 'broker.example',
          utmSource: 'email',
          privateMessage: 'must not persist',
        },
      }),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { success: true });

    const [event] = await getStorage().listAnalyticsEvents({ limit: 1 });
    assert.equal(event.event_name, 'criteria_downloaded');
    assert.equal(event.path, '/criteria');
    assert.equal(event.placement, 'criteria_page');
    assert.equal(event.referrer_host, 'broker.example');
    assert.doesNotMatch(JSON.stringify(event), /203\.0\.113\.19|must not persist/);
  });
});

test('unknown API routes return a JSON 404 instead of falling through to the app shell', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/not-a-real-endpoint`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'API endpoint not found.',
    });
  });
});

test('viewer and unauthenticated callers cannot trigger daily digest', async () => {
  let runnerCalls = 0;
  const app = createApp({
    dailyDealHunterRunner: async () => {
      runnerCalls += 1;
      return { emailResult: { status: 'sent', providerMessageId: 'must-not-run' } };
    },
  });
  await withServer(async (origin) => {
    const anonymous = await fetch(`${origin}/api/admin/deal-hunter/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(anonymous.status, 401);

    const viewerCookie = await signInForCookie(origin, {
      username: 'smb-deal-hunter', password: 'view-only-local',
    });
    const viewer = await fetch(`${origin}/api/admin/deal-hunter/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: '{}',
    });
    assert.equal(viewer.status, 401);
    assert.equal(runnerCalls, 0);
  }, app);
});

test('daily digest admin route rejects recipient subject body and unknown input', async () => {
  let runnerCalls = 0;
  const app = createApp({
    dailyDealHunterRunner: async () => {
      runnerCalls += 1;
      return {
        jobKey: 'daily-deal-hunter-email:2026-07-15',
        notificationType: 'normal-digest',
        emailResult: { status: 'sent', providerMessageId: 'resend-1' },
        jobRun: { status: 'completed', metadata: { preparedEnvelope: { to: 'digest@example.test', text: 'secret' } } },
      };
    },
  });
  await withServer(async (origin) => {
    const cookie = await signInForCookie(origin);
    for (const body of [
      { recipient: 'attacker@example.test' },
      { subject: 'Override' },
      { body: 'Override' },
      { html: '<p>Override</p>' },
      { notificationType: 'required-source-alert' },
      { providerKey: 'new-key' },
      { unknown: true },
    ]) {
      const response = await fetch(`${origin}/api/admin/deal-hunter/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(runnerCalls, 0);

    const allowed = await fetch(`${origin}/api/admin/deal-hunter/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
    });
    assert.equal(allowed.status, 200);
    const payload = await allowed.json();
    assert.equal(runnerCalls, 1);
    assert.doesNotMatch(JSON.stringify(payload), /digest@example\.test|preparedEnvelope|secret/);
  }, app);
});

test('daily digest cron route requires secret enforces due time and accepts no content', async () => {
  const calls = [];
  const app = createApp({
    dailyDealHunterRunner: async (input) => {
      calls.push(input);
      return { jobKey: 'daily-deal-hunter-email:2026-07-15', emailResult: { status: 'not-due' } };
    },
  });
  await withServer(async (origin) => {
    const unauthorized = await fetch(`${origin}/api/deal-hunter/daily-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(unauthorized.status, 401);

    const rejected = await fetch(`${origin}/api/deal-hunter/daily-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Deal-Hunter-Secret': 'task-three-cron-secret' },
      body: JSON.stringify({ recipient: 'attacker@example.test' }),
    });
    assert.equal(rejected.status, 400);

    const dueControlled = await fetch(`${origin}/api/deal-hunter/daily-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Deal-Hunter-Secret': 'task-three-cron-secret' },
      body: '{}',
    });
    assert.equal(dueControlled.status, 409);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].enforceDueTime, true);
    assert.equal(calls[0].triggeredBy, 'external-cron');
  }, app);
});

test('daily digest routes return completed active retry-not-due failed and ambiguous states precisely', async () => {
  const cases = [
    ['completed', { alreadySent: true, emailResult: { status: 'already-sent' }, jobRun: { status: 'completed' } }, 200],
    ['active', { inProgress: true, emailResult: { status: 'in-progress' }, jobRun: { status: 'pending' } }, 409],
    ['retry-not-due', { emailResult: { status: 'retry-not-due' }, jobRun: { status: 'failed' } }, 409],
    ['failed', { emailResult: { status: 'failed', errorCategory: 'provider-nonacceptance' }, jobRun: { status: 'failed' } }, 502],
    ['ambiguous', { emailResult: { status: 'ambiguous', errorCategory: 'provider-timeout' }, jobRun: { status: 'ambiguous' } }, 409],
  ];
  for (const [label, result, expectedStatus] of cases) {
    const app = createApp({ dailyDealHunterRunner: async () => ({ jobKey: `${label}:2026-07-15`, ...result }) });
    await withServer(async (origin) => {
      const cookie = await signInForCookie(origin);
      const response = await fetch(`${origin}/api/admin/deal-hunter/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
      });
      assert.equal(response.status, expectedStatus, label);
      const payload = await response.json();
      assert.equal(payload.status, result.emailResult.status, label);
      assert.doesNotMatch(JSON.stringify(payload), /metadata|preparedEnvelope|recipient/);
    }, app);
  }
});

test('daily digest privileged routes reject unsupported nonempty wire bodies', async () => {
  let runnerCalls = 0;
  const app = createApp({
    dailyDealHunterRunner: async () => {
      runnerCalls += 1;
      return {
        jobKey: 'daily-deal-hunter-email:2026-07-15',
        notificationType: 'normal-digest',
        emailResult: { status: 'sent', provider: 'resend', providerMessageId: 'wire-body-test-1' },
        jobRun: { status: 'completed' },
      };
    },
  });
  await withServer(async (origin) => {
    const adminCookie = await signInForCookie(origin);
    const routes = [
      ['/api/admin/deal-hunter/send', { Cookie: adminCookie }],
      ['/api/deal-hunter/daily-email', { 'X-Deal-Hunter-Secret': 'task-three-cron-secret' }],
    ];

    for (const [route, authorization] of routes) {
      for (const contentType of ['text/plain', 'application/octet-stream']) {
        const response = await fetch(`${origin}${route}`, {
          method: 'POST',
          headers: { ...authorization, 'Content-Type': contentType },
          body: 'nonempty privileged trigger payload',
        });
        assert.ok([400, 415].includes(response.status), `${route} ${contentType}`);
      }
      const chunked = await postChunked(`${origin}${route}`, {
        headers: { ...authorization, 'Content-Type': 'text/plain' },
        body: 'chunked nonempty privileged trigger payload',
      });
      assert.ok([400, 415].includes(chunked.status), `${route} chunked`);
    }
    assert.equal(runnerCalls, 0);

    for (const [route, authorization] of routes) {
      const empty = await fetch(`${origin}${route}`, { method: 'POST', headers: authorization });
      assert.ok([200, 409].includes(empty.status), `${route} truly empty`);
      const emptyJson = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.ok([200, 409].includes(emptyJson.status), `${route} exact empty JSON object`);
      const property = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ unexpected: true }),
      });
      assert.equal(property.status, 400, `${route} JSON property`);
    }
    assert.equal(runnerCalls, 4);
  }, app);
});

test('viewer Deal Hunter review sanitizer removes provider identities without changing safe status fields', () => {
  const sanitizeViewerDealHunterReview = appModule.sanitizeViewerDealHunterReview;
  assert.equal(typeof sanitizeViewerDealHunterReview, 'function');

  const reviewBuckets = ['newlySeenMatches', 'qualified', 'watchlist', 'removalCandidates'];
  const review = {
    generatedAt: '2026-09-08T16:00:00.000Z',
    dailyEmailJob: {
      status: 'completed',
      businessDate: '2026-09-08',
      attemptCount: 1,
      providerMessageId: 'viewer-digest-provider-sentinel',
    },
    ...Object.fromEntries(reviewBuckets.map((bucket, index) => [bucket, [{
      dealKey: `viewer-provider-privacy-${index}`,
      score: 80 + index,
      cimRequest: {
        status: 'sent',
        requestState: 'provider_accepted',
        deliveryState: 'accepted',
        followUpState: 'not-scheduled',
        requestedAt: '2026-09-08T15:00:00.000Z',
        firstProviderAcceptedAt: '2026-09-08T15:00:01.000Z',
        lastActivityAt: '2026-09-08T15:00:01.000Z',
        followUpCount: index,
        recipientPolicy: { blocked: false, touches24Hours: 1, touches30Days: 1 },
        providerMessageId: `viewer-cim-provider-sentinel-${index}`,
      },
    }]])),
  };
  const originalReview = structuredClone(review);

  const sanitized = sanitizeViewerDealHunterReview(review);

  assert.notStrictEqual(sanitized, review);
  assert.notStrictEqual(sanitized.dailyEmailJob, review.dailyEmailJob);
  const { providerMessageId: _digestProviderMessageId, ...safeDailyEmailJob } = originalReview.dailyEmailJob;
  assert.deepEqual(sanitized.dailyEmailJob, safeDailyEmailJob);
  for (const bucket of reviewBuckets) {
    assert.notStrictEqual(sanitized[bucket], review[bucket]);
    assert.notStrictEqual(sanitized[bucket][0], review[bucket][0]);
    assert.notStrictEqual(sanitized[bucket][0].cimRequest, review[bucket][0].cimRequest);
    const { providerMessageId: _cimProviderMessageId, ...safeCimRequest } = originalReview[bucket][0].cimRequest;
    assert.deepEqual(sanitized[bucket][0].cimRequest, safeCimRequest, bucket);
  }
  assert.deepEqual(review, originalReview);
});

test('Deal Hunter review hides explicit configured delivery addresses from administrator and viewer browsers', async () => {
  const sentinels = {
    admin: 'browser-private-admin@example.invalid',
    fallback: 'browser-private-fallback@example.invalid',
    recipient: 'digest-private-recipient@example.invalid',
    sender: 'digest-private-sender@example.invalid',
    replyTo: 'digest-private-reply@example.invalid',
    followUpSender: 'follow-private-sender@example.invalid',
    followUpReplyTo: 'follow-private-reply@example.invalid',
  };

  await withEmailReadinessAddressConfig({
    adminEmail: sentinels.admin,
    fallbackRecipient: sentinels.fallback,
    dealHunterRecipient: sentinels.recipient,
    fromAddress: `Private Sender <${sentinels.sender}>`,
    replyToAddress: sentinels.replyTo,
    followUpSenderAddress: sentinels.followUpSender,
    followUpReplyToAddress: sentinels.followUpReplyTo,
  }, async () => {
    await withServer(async (origin) => {
      const adminCookie = await signInForCookie(origin);
      const viewerCookie = await signInForCookie(origin, {
        username: 'smb-deal-hunter', password: 'view-only-local',
      });
      const unauthenticated = await fetch(`${origin}/api/admin/deal-hunter/review`);
      assert.equal(unauthenticated.status, 401);

      for (const [role, cookie] of [['administrator', adminCookie], ['viewer', viewerCookie]]) {
        const response = await fetch(`${origin}/api/admin/deal-hunter/review`, { headers: { Cookie: cookie } });
        const payload = await response.json();
        assert.equal(response.status, 200, role);
        for (const field of [
          'fromAddress', 'replyToAddress', 'followUpSenderAddress', 'followUpReplyToAddress',
          'testRecipient', 'allowedTestRecipients',
        ]) {
          assert.equal(Object.hasOwn(payload.review.emailReadiness, field), false, `${role} ${field}`);
        }
        const serialized = JSON.stringify(payload);
        for (const sentinel of Object.values(sentinels)) {
          assert.equal(serialized.includes(sentinel), false, `${role} ${sentinel}`);
        }
        assert.equal(payload.review.emailReadiness.provider, 'resend', role);
        assert.equal(payload.review.emailReadiness.outboundConfigured, true, role);
        assert.equal(payload.review.emailReadiness.recipientConfigured, true, role);
        assert.equal(payload.review.emailReadiness.senderConfigured, true, role);
        assert.equal(payload.review.emailReadiness.replyToConfigured, true, role);
        assert.equal(payload.review.emailReadiness.webhookConfigured, true, role);
        assert.ok(Array.isArray(payload.review.emailReadiness.issues), role);
        assert.equal(typeof payload.review.emailReadiness.metrics, 'object', role);
      }
    });
  });
});

test('Deal Hunter review hides the ADMIN_EMAIL Daily Digest recipient fallback for both browser roles', async () => {
  const fallbackSentinel = 'digest-admin-fallback-private@example.invalid';

  await withEmailReadinessAddressConfig({
    adminEmail: fallbackSentinel,
    fallbackRecipient: 'lead-notification-private@example.invalid',
    dealHunterRecipient: '',
    fromAddress: 'fallback-private-sender@example.invalid',
    replyToAddress: 'fallback-private-reply@example.invalid',
    followUpSenderAddress: 'fallback-follow-sender@example.invalid',
    followUpReplyToAddress: 'fallback-follow-reply@example.invalid',
  }, async () => {
    await withServer(async (origin) => {
      const adminCookie = await signInForCookie(origin);
      const viewerCookie = await signInForCookie(origin, {
        username: 'smb-deal-hunter', password: 'view-only-local',
      });

      for (const [role, cookie] of [['administrator', adminCookie], ['viewer', viewerCookie]]) {
        const response = await fetch(`${origin}/api/admin/deal-hunter/review`, { headers: { Cookie: cookie } });
        const payload = await response.json();
        assert.equal(response.status, 200, role);
        assert.equal(JSON.stringify(payload).includes(fallbackSentinel), false, role);
        assert.equal(payload.review.emailReadiness.recipientConfigured, true, role);
        assert.equal(payload.review.emailReadiness.recipientValid, true, role);
      }
    });
  });
});

test('browser email readiness projection is an explicit non-mutating safe-field projection', async () => {
  await withEmailReadinessAddressConfig({
    adminEmail: 'projection-private-admin@example.invalid',
    fallbackRecipient: 'projection-private-fallback@example.invalid',
    dealHunterRecipient: 'projection-private-digest@example.invalid',
    fromAddress: 'Projection Sender <projection-private-sender@example.invalid>',
    replyToAddress: 'projection-private-reply@example.invalid',
    followUpSenderAddress: 'projection-private-follow-sender@example.invalid',
    followUpReplyToAddress: 'projection-private-follow-reply@example.invalid',
  }, async (config) => {
    const internal = buildEmailReadiness({
      config,
      metricsAvailable: true,
      sentLast24Hours: 2,
      operationalMetrics: { suppressions: { active: 1 } },
    });
    const original = structuredClone(internal);
    const projectBrowserEmailReadiness = appModule.projectBrowserEmailReadiness;
    assert.equal(typeof projectBrowserEmailReadiness, 'function');

    const projected = projectBrowserEmailReadiness(internal);

    assert.notStrictEqual(projected, internal);
    assert.notStrictEqual(projected.metrics, internal.metrics);
    assert.notStrictEqual(projected.issues, internal.issues);
    assert.deepEqual(internal, original);
    assert.deepEqual({
      provider: projected.provider,
      outboundConfigured: projected.outboundConfigured,
      recipientConfigured: projected.recipientConfigured,
      recipientValid: projected.recipientValid,
      senderConfigured: projected.senderConfigured,
      replyToConfigured: projected.replyToConfigured,
      webhookConfigured: projected.webhookConfigured,
      metricsAvailable: projected.metricsAvailable,
      sentLast24Hours: projected.metrics.sentLast24Hours,
    }, {
      provider: 'resend',
      outboundConfigured: true,
      recipientConfigured: true,
      recipientValid: true,
      senderConfigured: true,
      replyToConfigured: true,
      webhookConfigured: true,
      metricsAvailable: true,
      sentLast24Hours: 2,
    });
    for (const field of [
      'fromAddress', 'replyToAddress', 'followUpSenderAddress', 'followUpReplyToAddress',
      'testRecipient', 'allowedTestRecipients',
    ]) {
      assert.equal(Object.hasOwn(projected, field), false, field);
    }
  });
});

test('Operations hides configured readiness addresses from administrator and viewer browsers', async () => {
  const sentinels = {
    testRecipient: 'operations-private-admin@example.invalid',
    allowedRecipient: 'operations-private-fallback@example.invalid',
    recipient: 'operations-private-digest@example.invalid',
    sender: 'operations-private-sender@example.invalid',
    replyTo: 'operations-private-reply@example.invalid',
    followUpSender: 'operations-private-follow-sender@example.invalid',
    followUpReplyTo: 'operations-private-follow-reply@example.invalid',
  };

  await withEmailReadinessAddressConfig({
    adminEmail: sentinels.testRecipient,
    fallbackRecipient: sentinels.allowedRecipient,
    dealHunterRecipient: sentinels.recipient,
    fromAddress: `Operations Sender <${sentinels.sender}>`,
    replyToAddress: sentinels.replyTo,
    followUpSenderAddress: sentinels.followUpSender,
    followUpReplyToAddress: sentinels.followUpReplyTo,
  }, async () => {
    await withServer(async (origin) => {
      const adminCookie = await signInForCookie(origin);
      const viewerCookie = await signInForCookie(origin, {
        username: 'smb-deal-hunter', password: 'view-only-local',
      });
      const unauthenticated = await fetch(`${origin}/api/admin/operations`);
      assert.equal(unauthenticated.status, 401);

      for (const [role, cookie] of [['administrator', adminCookie], ['viewer', viewerCookie]]) {
        const response = await fetch(`${origin}/api/admin/operations`, { headers: { Cookie: cookie } });
        const payload = await response.json();
        assert.equal(response.status, 200, role);
        for (const field of [
          'fromAddress', 'replyToAddress', 'followUpSenderAddress', 'followUpReplyToAddress',
        ]) {
          assert.equal(Object.hasOwn(payload.operations.email, field), false, `${role} ${field}`);
        }
        if (role === 'administrator') {
          assert.equal(Object.hasOwn(payload.operations.email, 'testRecipient'), false, role);
          assert.equal(Object.hasOwn(payload.operations.email, 'allowedTestRecipients'), false, role);
        } else {
          assert.equal(payload.operations.email.testRecipient, '', role);
          assert.deepEqual(payload.operations.email.allowedTestRecipients, [], role);
        }
        const serialized = JSON.stringify(payload);
        for (const sentinel of Object.values(sentinels)) {
          assert.equal(serialized.includes(sentinel), false, `${role} ${sentinel}`);
        }
        assert.equal(payload.operations.email.provider, 'resend', role);
        assert.equal(payload.operations.email.outboundConfigured, true, role);
        assert.equal(payload.operations.email.recipientConfigured, true, role);
        assert.equal(payload.operations.email.senderConfigured, true, role);
        assert.equal(payload.operations.email.replyToConfigured, true, role);
        assert.equal(payload.operations.email.followUpSenderConfigured, true, role);
        assert.equal(payload.operations.email.followUpReplyToConfigured, true, role);
        assert.equal(payload.operations.email.webhookConfigured, true, role);
        assert.ok(Array.isArray(payload.operations.email.issues), role);
        assert.equal(typeof payload.operations.email.metrics, 'object', role);
      }
    });
  });
});

test('Review and Operations hide readiness event content and identities from both browser roles', async () => {
  const storage = getStorage();
  const sentinels = {
    subject: 'PRIVATE HTTP READINESS SUBJECT SENTINEL',
    recipient: 'private-http-readiness-recipient@example.invalid',
    sender: 'private-http-readiness-sender@example.invalid',
    replyTo: 'private-http-readiness-reply@example.invalid',
    providerMessageId: 'private-http-readiness-provider-id',
    rawProviderResponse: 'PRIVATE HTTP READINESS RAW PROVIDER RESPONSE',
    error: 'PRIVATE HTTP READINESS ERROR STACK PATH CREDENTIAL',
    futureSecret: 'PRIVATE HTTP READINESS FUTURE SECRET',
  };
  const createdAt = '2099-09-08T15:00:00.000Z';
  await storage.insertEmailEvent({
    id: 'browser-readiness-event-privacy',
    event_key: 'browser-readiness-event-privacy',
    created_at: createdAt,
    provider: 'resend',
    event_type: 'delivered',
    message_id: sentinels.providerMessageId,
    provider_event_id: 'private-http-readiness-provider-event-id',
    recipient_email: sentinels.recipient,
    subject: Object.values(sentinels).join(' | '),
    submission_id: null,
    source: 'admin-email-test',
    metadata: {
      sender: sentinels.sender,
      replyTo: sentinels.replyTo,
      rawProviderResponse: sentinels.rawProviderResponse,
      error: sentinels.error,
      futureSecret: sentinels.futureSecret,
    },
  });

  await withEmailReadinessAddressConfig({
    adminEmail: sentinels.recipient,
    fallbackRecipient: 'private-http-readiness-fallback@example.invalid',
    dealHunterRecipient: 'private-http-readiness-digest@example.invalid',
    fromAddress: `Private HTTP Sender <${sentinels.sender}>`,
    replyToAddress: sentinels.replyTo,
    followUpSenderAddress: 'private-http-readiness-follow-sender@example.invalid',
    followUpReplyToAddress: 'private-http-readiness-follow-reply@example.invalid',
  }, async () => {
    await withServer(async (origin) => {
      const adminCookie = await signInForCookie(origin);
      const viewerCookie = await signInForCookie(origin, {
        username: 'smb-deal-hunter', password: 'view-only-local',
      });
      for (const [role, cookie] of [['administrator', adminCookie], ['viewer', viewerCookie]]) {
        for (const [route, responseKey] of [
          ['/api/admin/deal-hunter/review', 'review'],
          ['/api/admin/operations', 'operations'],
        ]) {
          const response = await fetch(`${origin}${route}`, { headers: { Cookie: cookie } });
          const payload = await response.json();
          assert.equal(response.status, 200, `${role} ${route}`);
          const readiness = payload[responseKey].emailReadiness || payload[responseKey].email;
          assert.deepEqual(readiness.latestTestEvent, {
            createdAt,
            eventType: 'delivered',
            source: 'admin-email-test',
          }, `${role} ${route}`);
          const serialized = JSON.stringify(payload);
          for (const sentinel of Object.values(sentinels)) {
            assert.equal(serialized.includes(sentinel), false, `${role} ${route} ${sentinel}`);
          }
          if (role === 'viewer') {
            assert.equal(serialized.includes('providerMessageId'), false, `${role} ${route}`);
          }
        }
      }
    });
  });
});

test('daily digest browser responses exclude the raw prepared envelope and job metadata', async () => {
  const storage = getStorage();
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateParts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const businessDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const jobKey = `daily-deal-hunter-email:${businessDate}`;
  const nowIso = now.toISOString();
  const sentinels = {
    recipient: 'sentinel-recipient@example.test',
    sender: 'sentinel-sender@example.test',
    subject: 'SENTINEL PRIVATE SUBJECT',
    text: 'SENTINEL PRIVATE TEXT BODY',
    html: '<strong>SENTINEL PRIVATE HTML BODY</strong>',
    claimToken: 'http-sensitive-claim-token-0001',
    rawMetadata: 'SENTINEL RAW METADATA',
  };
  const claim = await storage.claimScheduledJob({
    jobKey,
    jobName: 'daily-deal-hunter-email',
    triggeredBy: 'test',
    claimToken: sentinels.claimToken,
    nowIso,
    staleBefore: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    retryDueAt: nowIso,
    metadata: {
      businessDate,
      notificationType: 'normal-digest',
      rawMetadata: sentinels.rawMetadata,
      recipient: sentinels.recipient,
      preparedEnvelope: {
        to: sentinels.recipient,
        from: sentinels.sender,
        subject: sentinels.subject,
        text: sentinels.text,
        html: sentinels.html,
        idempotencyKey: jobKey,
      },
    },
  });
  assert.equal(claim.applied, true);

  await withServer(async (origin) => {
    const adminCookie = await signInForCookie(origin);
    const viewerCookie = await signInForCookie(origin, {
      username: 'smb-deal-hunter', password: 'view-only-local',
    });
    const payloads = [];

    for (const cookie of [adminCookie, viewerCookie]) {
      const response = await fetch(`${origin}/api/admin/deal-hunter/review`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      payloads.push(await response.json());
    }

    const csv = Buffer.from([
      'Listing ID,Business Name,View Listing URL,SDE',
      'HTTP-SAFE-STATUS-1,Safe Status Fixture,https://broker.example/http-safe-status,425000',
    ].join('\n'));
    const imported = await fetch(`${origin}/api/admin/deal-hunter/deal-os-import`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'text/csv',
        'X-Deal-OS-File-Name': encodeURIComponent('deal-os-safe-status.csv'),
        'X-Deal-OS-Exported-At': nowIso,
        'X-Deal-OS-Scope': 'saved-search',
        'X-Deal-OS-Coverage-Label': encodeURIComponent('Daily digest status projection test'),
        'X-Deal-OS-Expected-Row-Count': '1',
      },
      body: csv,
    });
    assert.equal(imported.status, 201);
    payloads.push(await imported.json());

    const backfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
      method: 'POST', headers: { Cookie: adminCookie },
    });
    assert.equal(backfill.status, 200);
    payloads.push(await backfill.json());

    const crmSync = await fetch(`${origin}/api/admin/deal-hunter/crm-sync`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'SYNC HIGH FITS',
        expectedDealKeys: ['source:test:nonexistent-safe-status'],
        reviewMode: 'daily',
      }),
    });
    assert.ok([400, 409, 503].includes(crmSync.status));
    payloads.push(await crmSync.json());

    const serialized = JSON.stringify(payloads);
    assert.doesNotMatch(serialized, /preparedEnvelope/);
    for (const [label, sentinel] of Object.entries(sentinels)) {
      assert.equal(serialized.includes(sentinel), false, label);
    }
    for (const payload of payloads) {
      assert.equal(payload.review.dailyEmailJob.status, 'pending');
    }

    const viewerProviderSentinel = 'viewer-raw-provider-sentinel-9f2';
    const completed = await storage.transitionScheduledJob({
      jobKey,
      claimToken: sentinels.claimToken,
      expectedStatuses: ['pending'],
      status: 'completed',
      nowIso,
      completedAt: nowIso,
      providerMessageId: viewerProviderSentinel,
      metadataPatch: { provider: 'resend', payloadDigest: 'a'.repeat(64) },
    });
    assert.equal(completed.applied, true);

    const adminReviewResponse = await fetch(`${origin}/api/admin/deal-hunter/review`, { headers: { Cookie: adminCookie } });
    const viewerReviewResponse = await fetch(`${origin}/api/admin/deal-hunter/review`, { headers: { Cookie: viewerCookie } });
    const adminReview = await adminReviewResponse.json();
    const viewerReview = await viewerReviewResponse.json();
    assert.equal(adminReviewResponse.status, 200);
    assert.equal(viewerReviewResponse.status, 200);

    const { providerMessageId: adminDigestProviderMessageId, ...adminSafeDailyEmailJob } = adminReview.review.dailyEmailJob;
    assert.equal(adminDigestProviderMessageId, viewerProviderSentinel);
    assert.equal(Object.hasOwn(viewerReview.review.dailyEmailJob, 'providerMessageId'), false);
    assert.deepEqual(viewerReview.review.dailyEmailJob, adminSafeDailyEmailJob);
    const serializedViewerReview = JSON.stringify(viewerReview);
    assert.equal(serializedViewerReview.includes(viewerProviderSentinel), false);

    const adminOperationsResponse = await fetch(`${origin}/api/admin/operations`, { headers: { Cookie: adminCookie } });
    const viewerOperationsResponse = await fetch(`${origin}/api/admin/operations`, { headers: { Cookie: viewerCookie } });
    const adminOperations = await adminOperationsResponse.json();
    const viewerOperations = await viewerOperationsResponse.json();
    assert.equal(adminOperationsResponse.status, 200);
    assert.equal(viewerOperationsResponse.status, 200);
    assert.equal(adminOperations.operations.dailyDigest.providerMessageId, viewerProviderSentinel);
    assert.equal(Object.hasOwn(viewerOperations.operations.dailyDigest, 'providerMessageId'), false);
    assert.equal(JSON.stringify(viewerOperations).includes(viewerProviderSentinel), false);
  });
});

test('readiness checks storage and the document vault', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      checks: {
        configuration: 'ok',
        storage: 'ok',
        cimStage2Storage: 'ok',
        documentVault: 'ok',
      },
    });
  });
});

test('secure upload token is rejected before parsing the JSON payload', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/secure-documents/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Secure-Upload-Token': 'invalid-token',
      },
      body: '{this is intentionally invalid JSON',
    });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.match(result.error, /invalid or has expired/i);
  });
});

test('completed secure upload requests are rejected before parsing the JSON payload', async () => {
  const created = await createManualSubmission({
    company: 'Completed Upload Test',
    seller_name: 'Completed Seller',
    seller_email: 'completed-upload@example.com',
    lead_type: 'seller',
  }, 'test');
  const upload = await createSecureUploadRequest({
    submissionId: created.submission.id,
    requestedBy: 'test',
    sendEmail: false,
    request: { headers: { host: 'localhost' }, ip: '192.0.2.88', socket: {} },
  });
  await getStorage().updateSecureUploadRequest(upload.request.id, {
    updated_at: new Date().toISOString(),
    status: 'documents-received',
  });
  const token = new URL(upload.uploadUrl).searchParams.get('token');

  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/secure-documents/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Secure-Upload-Token': token,
      },
      body: '{this body must not be parsed',
    });
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.match(result.error, /request is closed/i);
  });
});

test('admin mutations create a durable started audit event and a completion event', async () => {
  const requestId = 'phase15-audit-test';
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    assert.equal(response.status, 401);
  });

  let events = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    events = await getStorage().listAdminAuditEvents({ requestId });
    if (events.length >= 2) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(events.map((event) => event.metadata.state).sort(), ['completed', 'started']);
  assert.equal(events.find((event) => event.metadata.state === 'completed').status_code, 401);

  const successRequestId = 'phase15-audit-success-test';
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': successRequestId },
      body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
    });
    assert.equal(response.status, 200);
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    events = await getStorage().listAdminAuditEvents({ requestId: successRequestId });
    if (events.length >= 2) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const completion = events.find((event) => event.metadata.state === 'completed');
  assert.equal(completion.status_code, 200);
  assert.equal(completion.actor, 'admin');
});

test('admin mutations fail closed when the durable audit prewrite is unavailable', async () => {
  const storage = getStorage();
  const originalInsert = storage.insertAdminAuditEvent;
  storage.insertAdminAuditEvent = async () => {
    throw new Error('audit database unavailable');
  };

  try {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
      });
      const result = await response.json();
      assert.equal(response.status, 503);
      assert.match(result.error, /audit storage is unavailable/i);
      assert.equal(response.headers.get('set-cookie'), null);
    });
  } finally {
    storage.insertAdminAuditEvent = originalInsert;
  }
});

test('CRM updates reject stale admin drafts with a conflict', async () => {
  await withServer(async (origin) => {
    const loginResponse = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const createResponse = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        company: 'Concurrency Test Services',
        seller_name: 'Concurrency Seller',
        seller_email: 'concurrency@example.com',
        lead_type: 'seller',
        message: 'Record used to verify stale admin update protection.',
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).submission;

    const firstUpdate = await fetch(`${origin}/api/admin/submissions/${created.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        expected_updated_at: created.updated_at,
        notes: 'First editor update',
      }),
    });
    assert.equal(firstUpdate.status, 200);

    const staleUpdate = await fetch(`${origin}/api/admin/submissions/${created.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        expected_updated_at: created.updated_at,
        notes: 'Stale editor update',
      }),
    });
    const staleResult = await staleUpdate.json();
    assert.equal(staleUpdate.status, 409);
    assert.match(staleResult.error, /changed after you opened it/i);
    assert.equal(staleResult.submission.notes, 'First editor update');
  });
});

test('CRM updates require an expected record version', async () => {
  await withServer(async (origin) => {
    const loginResponse = await fetch(`${origin}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'change-me-now' }),
    });
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const createResponse = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        company: 'Required Version Services',
        seller_name: 'Version Seller',
        seller_email: 'required-version@example.com',
        lead_type: 'seller',
      }),
    });
    const created = (await createResponse.json()).submission;
    const response = await fetch(`${origin}/api/admin/submissions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ notes: 'missing expected version' }),
    });
    assert.equal(response.status, 409);
  });
});

test('communications and lead lifecycle endpoints enforce viewer read-only access and explicit archive semantics', async () => {
  await withServer(async (origin) => {
    const login = async (username, password) => {
      const response = await fetch(`${origin}/api/admin/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Fly-Client-Ip': username === 'admin' ? '203.0.113.91' : '203.0.113.92',
        },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const adminCookie = await login('admin', 'change-me-now');
    const viewerCookie = await login('smb-deal-hunter', 'view-only-local');
    lifecycleAdminCookie = adminCookie;
    lifecycleViewerCookie = viewerCookie;
    const directArchiveCreate = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        company: 'Invalid Direct Archive',
        lead_type: 'broker',
        broker_email: 'invalid-archive@example.com',
        status: 'archived',
      }),
    });
    assert.equal(directArchiveCreate.status, 400);
    assert.match(JSON.stringify(await directArchiveCreate.json()), /Archive Lead/i);
    const createResponse = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        company: 'HTTP Communications Services',
        broker_name: 'HTTP Broker',
        broker_email: 'http-broker@example.com',
        lead_type: 'broker',
        status: 'review',
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).submission;

    const viewerList = await fetch(`${origin}/api/admin/submissions/${created.id}/communications`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerList.status, 200);
    assert.deepEqual((await viewerList.json()).communications, []);

    const viewerWrite = await fetch(`${origin}/api/admin/submissions/${created.id}/communications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ direction: 'inbound', channel: 'phone', bodyText: 'Viewer must not write.' }),
    });
    assert.equal(viewerWrite.status, 401);
    const viewerInbox = await fetch(`${origin}/api/admin/communications/unassigned`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerInbox.status, 401);
    const viewerHistory = await fetch(`${origin}/api/admin/deal-hunter/cim-requests`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerHistory.status, 200);

    const manualRequestId = 'http-manual-communication-lifecycle';
    const archiveRequestId = 'http-archive-lifecycle';
    const restoreRequestId = 'http-restore-lifecycle';
    const loggedResponse = await fetch(`${origin}/api/admin/submissions/${created.id}/communications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-Request-ID': manualRequestId },
      body: JSON.stringify({
        direction: 'inbound',
        channel: 'phone',
        occurredAt: '2026-08-06T18:30:00.000Z',
        fromAddress: 'http-broker@example.com',
        subject: 'Availability update',
        bodyText: 'Broker said the deal is no longer available.',
        status: 'contacted',
        followUpState: 'waiting-on-owner',
      }),
    });
    assert.equal(loggedResponse.status, 201);
    const logged = await loggedResponse.json();
    assert.equal(logged.communication.body_text, 'Broker said the deal is no longer available.');
    assert.equal(logged.submission.status, 'contacted');

    const genericArchive = await fetch(`${origin}/api/admin/submissions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ expected_updated_at: logged.submission.updated_at, status: 'archived' }),
    });
    assert.equal(genericArchive.status, 400);

    const staleArchive = await fetch(`${origin}/api/admin/submissions/${created.id}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'unavailable', expectedUpdatedAt: created.updated_at }),
    });
    assert.equal(staleArchive.status, 409);

    const viewerArchive = await fetch(`${origin}/api/admin/submissions/${created.id}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ reason: 'unavailable' }),
    });
    assert.equal(viewerArchive.status, 401);
    const archiveResponse = await fetch(`${origin}/api/admin/submissions/${created.id}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-Request-ID': archiveRequestId },
      body: JSON.stringify({
        reason: 'unavailable',
        note: 'Archived from HTTP integration test.',
        communicationId: logged.communication.id,
        expectedUpdatedAt: logged.submission.updated_at,
      }),
    });
    assert.equal(archiveResponse.status, 200);
    const archived = (await archiveResponse.json()).submission;
    assert.equal(archived.status, 'archived');
    assert.equal(archived.archive_reason, 'unavailable');
    assert.equal(archived.archive_communication_id, logged.communication.id);

    const viewerRestore = await fetch(`${origin}/api/admin/submissions/${created.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ status: 'review', expectedUpdatedAt: archived.updated_at }),
    });
    assert.equal(viewerRestore.status, 401);
    const staleRestore = await fetch(`${origin}/api/admin/submissions/${created.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ status: 'review', expectedUpdatedAt: logged.submission.updated_at }),
    });
    assert.equal(staleRestore.status, 409);

    const restoreResponse = await fetch(`${origin}/api/admin/submissions/${created.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-Request-ID': restoreRequestId },
      body: JSON.stringify({ status: 'review', expectedUpdatedAt: archived.updated_at }),
    });
    assert.equal(restoreResponse.status, 200);
    const restored = (await restoreResponse.json()).submission;
    assert.equal(restored.status, 'review');
    assert.equal(restored.follow_up_state, 'completed');
    assert.equal(restored.next_action_at, null);

    const storage = getStorage();
    for (const [requestId, expectedStatus] of [
      [manualRequestId, 201],
      [archiveRequestId, 200],
      [restoreRequestId, 200],
    ]) {
      let events = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        events = await storage.listAdminAuditEvents({ requestId });
        if (events.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(events.map((event) => event.metadata.state).sort(), ['completed', 'started']);
      assert.equal(events.find((event) => event.metadata.state === 'completed').status_code, expectedStatus);
      assert.equal(events.find((event) => event.metadata.state === 'completed').actor, 'admin');
    }
  });
});

test('Deal OS export import requires a full administrator and records the authenticated importer', async () => {
  await withServer(async (origin) => {
    const adminCookie = lifecycleAdminCookie;
    const viewerCookie = lifecycleViewerCookie;
    assert.ok(adminCookie);
    assert.ok(viewerCookie);
    const csv = Buffer.from([
      'Listing ID,Business Name,View Listing URL,SDE',
      'HTTP-IMPORT-1,Commercial Fire Inspection,https://broker.example/http-import,425000',
    ].join('\n'));
    const scoresBefore = await getStorage().listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 100 });
    const importHeaders = {
      'Content-Type': 'text/csv',
      'X-Deal-OS-File-Name': encodeURIComponent('deal-os-http.csv'),
      'X-Deal-OS-Exported-At': new Date().toISOString(),
      'X-Deal-OS-Scope': 'saved-search',
      'X-Deal-OS-Coverage-Label': encodeURIComponent('HTTP authorization test'),
      'X-Deal-OS-Expected-Row-Count': '1',
    };
    const anonymous = await fetch(`${origin}/api/admin/deal-hunter/deal-os-import`, {
      method: 'POST',
      headers: importHeaders,
      body: csv,
    });
    assert.equal(anonymous.status, 401);

    const viewer = await fetch(`${origin}/api/admin/deal-hunter/deal-os-import`, {
      method: 'POST',
      headers: { ...importHeaders, Cookie: viewerCookie },
      body: csv,
    });
    assert.equal(viewer.status, 401);

    const response = await fetch(`${origin}/api/admin/deal-hunter/deal-os-import`, {
      method: 'POST',
      headers: { ...importHeaders, Cookie: adminCookie },
      body: csv,
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.success, true);
    assert.equal(result.import.rowCount, 1);
    assert.equal(result.import.importedBy, 'admin');
    assert.equal(result.summary.importedRows, 1);
    assert.equal(result.review.scoringDeferred, true);
    assert.equal(result.review.totals.reviewedDeals, 0);
    assert.deepEqual(result.review.qualified, []);
    assert.deepEqual(result.review.watchlist, []);
    assert.deepEqual(result.review.removalCandidates, []);
    assert.deepEqual(result.review.criteriaRecommendations, []);
    assert.deepEqual(result.review.crmSyncPreview, { count: 0, dealKeys: [] });
    assert.equal(result.scoreRefresh, null);
    assert.match(result.reviewWarning, /imported and retained.*scoring is deferred.*required Google Sheet/i);
    assert.equal(result.import.fieldCoverage.fields.find((field) => field.key === 'annualProfit').percent, 100);
    const stored = await getStorage().getLatestDealHunterDealOsImport();
    assert.equal(stored.imported_by, 'admin');
    assert.equal(stored.records[0].stableId, 'HTTP-IMPORT-1');
    const scoresAfter = await getStorage().listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 100 });
    assert.equal(scoresAfter.total, scoresBefore.total);
    assert.equal(scoresAfter.rows.some((score) => score.deal_key === 'source:deal-os-export:HTTP-IMPORT-1'), false);
  });
});

test('full-backfill scoring and explicit CRM sync require administrator access and exact confirmation', async () => {
  await withServer(async (origin) => {
    const adminCookie = lifecycleAdminCookie;
    const viewerCookie = lifecycleViewerCookie;
    assert.ok(adminCookie);
    assert.ok(viewerCookie);

    const anonymousBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, { method: 'POST' });
    assert.equal(anonymousBackfill.status, 401);
    const viewerBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
      method: 'POST',
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerBackfill.status, 401);

    const scoresBeforeBackfill = await getStorage().listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 100 });
    const adminBackfill = await fetch(`${origin}/api/admin/deal-hunter/backfill-review`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    const adminBackfillResult = await adminBackfill.json();
    assert.equal(adminBackfill.status, 200);
    assert.equal(adminBackfillResult.review.scoringDeferred, true);
    assert.equal(adminBackfillResult.review.totals.reviewedDeals, 0);
    assert.equal(adminBackfillResult.scoreRefresh, null);
    assert.match(adminBackfillResult.reviewWarning, /Full-backfill scoring is deferred.*existing persisted scores were left unchanged/i);
    const scoresAfterBackfill = await getStorage().listDealHunterOpportunityScores({ view: 'all', page: 1, pageSize: 100 });
    assert.equal(scoresAfterBackfill.total, scoresBeforeBackfill.total);

    const viewerSync = await fetch(`${origin}/api/admin/deal-hunter/crm-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ confirmation: 'SYNC HIGH FITS', reviewMode: 'daily' }),
    });
    assert.equal(viewerSync.status, 401);

    for (const route of ['preview', 'execute']) {
      const viewerReconciliation = await fetch(`${origin}/api/admin/deal-hunter/crm-reconciliation/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
        body: JSON.stringify({ importId: '00000000-0000-0000-0000-000000000000' }),
      });
      assert.equal(viewerReconciliation.status, 401);
    }
    const viewerAudit = await fetch(`${origin}/api/admin/deal-hunter/crm-integrity-audit`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerAudit.status, 401);

    // Triage: viewers may read the queue, only full administrators may decide.
    const viewerTriage = await fetch(`${origin}/api/admin/deal-hunter/triage?view=needs-review`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerTriage.status, 200);
    const viewerTriageResult = await viewerTriage.json();
    assert.equal(viewerTriageResult.success, true);
    assert.ok(Array.isArray(viewerTriageResult.rows));
    assert.equal(viewerTriageResult.sort, 'acquisition-priority');
    assert.deepEqual(Object.keys(viewerTriageResult.summary).sort(), [
      'currentOpportunities', 'highPriority', 'lowConfidence', 'needsReview', 'watchlist',
    ]);
    const fractionalTriage = await fetch(`${origin}/api/admin/deal-hunter/triage?page=1.9&pageSize=1.9`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(fractionalTriage.status, 200);
    const fractionalTriageResult = await fractionalTriage.json();
    assert.equal(fractionalTriageResult.page, 1);
    assert.equal(fractionalTriageResult.pageSize, 1);

    const anonymousTriage = await fetch(`${origin}/api/admin/deal-hunter/triage`);
    assert.equal(anonymousTriage.status, 401);

    const viewerDecision = await fetch(`${origin}/api/admin/deal-hunter/triage/opp-any/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ priority: 'urgent' }),
    });
    assert.equal(viewerDecision.status, 401, 'a read-only viewer cannot record an operator decision');

    const viewerRefresh = await fetch(`${origin}/api/admin/deal-hunter/scores/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ force: false }),
    });
    assert.equal(viewerRefresh.status, 401);

    // A full forced rebuild is bounded by a typed confirmation.
    const unconfirmedRebuild = await fetch(`${origin}/api/admin/deal-hunter/scores/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ force: true }),
    });
    const unconfirmedRebuildResult = await unconfirmedRebuild.json();
    assert.equal(unconfirmedRebuild.status, 400);
    assert.match(unconfirmedRebuildResult.error, /REBUILD ALL SCORES/);

    const missingTriageDetail = await fetch(`${origin}/api/admin/deal-hunter/triage/opp-missing`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(missingTriageDetail.status, 404);

    const missingReconciliationImport = await fetch(`${origin}/api/admin/deal-hunter/crm-reconciliation/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ importId: '00000000-0000-0000-0000-000000000000' }),
    });
    assert.equal(missingReconciliationImport.status, 404);

    const unconfirmedSync = await fetch(`${origin}/api/admin/deal-hunter/crm-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ confirmation: 'sync', reviewMode: 'daily' }),
    });
    const unconfirmedResult = await unconfirmedSync.json();
    assert.equal(unconfirmedSync.status, 400);
    assert.equal(unconfirmedResult.success, false);
    assert.equal(unconfirmedResult.confirmationRequired, 'SYNC HIGH FITS');
    assert.match(unconfirmedResult.error, /SYNC HIGH FITS/);

    const missingReviewedSet = await fetch(`${origin}/api/admin/deal-hunter/crm-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ confirmation: 'SYNC HIGH FITS', reviewMode: 'daily' }),
    });
    const missingReviewedSetResult = await missingReviewedSet.json();
    assert.equal(missingReviewedSet.status, 400);
    assert.equal(missingReviewedSetResult.success, false);
    assert.match(missingReviewedSetResult.error, /Refresh the Deal Hunter review/i);
  });
});

test('communication assignment, corrected retry, and Deal Hunter disposition enforce HTTP authorization and replay safety', async () => {
  await withServer(async (origin) => {
    const adminCookie = lifecycleAdminCookie;
    const viewerCookie = lifecycleViewerCookie;
    assert.ok(adminCookie);
    assert.ok(viewerCookie);
    const createResponse = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        company: 'HTTP Lifecycle Boundary Services',
        broker_name: 'Boundary Broker',
        broker_email: 'failed-boundary@example.com',
        lead_type: 'broker',
        status: 'review',
      }),
    });
    assert.equal(createResponse.status, 201);
    const submission = (await createResponse.json()).submission;

    const invalidOccurrence = await fetch(`${origin}/api/admin/submissions/${submission.id}/communications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ direction: 'inbound', channel: 'note', bodyText: 'Missing occurrence time.' }),
    });
    assert.equal(invalidOccurrence.status, 400);
    assert.match((await invalidOccurrence.json()).error, /occurrence date and time/i);

    const boundedCommunicationPage = await fetch(
      `${origin}/api/admin/submissions/${submission.id}/communications?page=Infinity&pageSize=1e309`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(boundedCommunicationPage.status, 200);
    const boundedCommunicationResult = await boundedCommunicationPage.json();
    assert.equal(boundedCommunicationResult.page, 1);
    assert.equal(boundedCommunicationResult.pageSize, 25);
    const boundedHistoryPage = await fetch(`${origin}/api/admin/deal-hunter/cim-requests?page=Infinity&pageSize=1e309`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(boundedHistoryPage.status, 200);
    const boundedHistoryResult = await boundedHistoryPage.json();
    assert.equal(boundedHistoryResult.page, 1);
    assert.equal(boundedHistoryResult.pageSize, 25);

    const storage = getStorage();
    const now = '2026-08-06T20:00:00.000Z';
    await storage.insertCrmCommunication({
      id: 'http-unassigned-communication',
      submission_id: null,
      deal_key: null,
      cim_request_id: null,
      direction: 'inbound',
      channel: 'email',
      source: 'resend-webhook',
      kind: 'broker-reply',
      provider: 'resend',
      provider_message_id: 'http-inbound-message',
      source_event_id: 'http-inbound-event',
      idempotency_key: null,
      in_reply_to: null,
      reply_to_address: null,
      from_address: 'shared-boundary@example.com',
      to_addresses: ['replies@example.test'],
      cc_addresses: [],
      bcc_addresses: [],
      subject: 'Boundary assignment',
      body_text: 'Assign this message through the authenticated HTTP endpoint.',
      body_html_sanitized: '',
      occurred_at: now,
      created_at: now,
      updated_at: now,
      delivery_state: 'replied',
      delivery_state_at: now,
      content_state: 'complete',
      content_attempt_count: 1,
      content_last_error: null,
      content_next_attempt_at: null,
      attachment_metadata: [],
      assigned_at: null,
      assigned_by: null,
      created_by: 'http-test',
      updated_by: 'http-test',
      metadata: {},
    });

    const viewerAssign = await fetch(`${origin}/api/admin/communications/http-unassigned-communication/assign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ submissionId: submission.id }),
    });
    assert.equal(viewerAssign.status, 401);
    const assignRequestId = 'http-communication-assignment';
    const assignedResponse = await fetch(`${origin}/api/admin/communications/http-unassigned-communication/assign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-Request-ID': assignRequestId },
      body: JSON.stringify({ submissionId: submission.id }),
    });
    assert.equal(assignedResponse.status, 200);
    assert.equal((await assignedResponse.json()).communication.submission_id, submission.id);
    const duplicateAssignment = await fetch(`${origin}/api/admin/communications/http-unassigned-communication/assign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ submissionId: submission.id }),
    });
    assert.equal(duplicateAssignment.status, 409);

    const cimRequestId = 'http-bounced-cim-request';
    await storage.upsertDealHunterCimRequest({
      id: cimRequestId,
      created_at: now,
      updated_at: now,
      first_requested_at: now,
      first_provider_accepted_at: now,
      last_attempt_at: now,
      last_delivery_event_at: now,
      last_activity_at: now,
      deal_key: 'http-boundary-deal',
      recipient_email: 'failed-boundary@example.com',
      subject: 'CIM request for HTTP Lifecycle Boundary Services',
      deal_name: 'HTTP Lifecycle Boundary Services',
      source_name: 'HTTP integration fixture',
      listing_url: 'https://broker.example.test/http-boundary-deal',
      score: 90,
      requested_by: 'http-test',
      status: 'delivery_issue',
      delivery_error: 'Email bounced.',
      provider_message_id: 'http-bounced-provider-message',
      follow_up_count: 0,
      submission_id: submission.id,
      request_state: 'provider_accepted',
      delivery_state: 'bounced',
      delivery_state_at: now,
      follow_up_state: 'stopped',
      attempt_count: 1,
      metadata: {
        brokerContacts: [{ name: 'Corrected Boundary Broker', email: 'corrected-boundary@example.com' }],
        brokerName: 'Boundary Broker',
        annualProfit: 450000,
      },
    });

    const viewerRetry = await fetch(`${origin}/api/admin/deal-hunter/cim-requests/${cimRequestId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ newRecipientEmail: 'corrected-boundary@example.com' }),
    });
    assert.equal(viewerRetry.status, 401);
    const invalidRetry = await fetch(`${origin}/api/admin/deal-hunter/cim-requests/${cimRequestId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ newRecipientEmail: 'failed-boundary@example.com' }),
    });
    assert.equal(invalidRetry.status, 400);
    const retryRequestId = 'http-corrected-cim-retry';
    const retryResponse = await fetch(`${origin}/api/admin/deal-hunter/cim-requests/${cimRequestId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-Request-ID': retryRequestId },
      body: JSON.stringify({ newRecipientEmail: 'corrected-boundary@example.com' }),
    });
    assert.equal(retryResponse.status, 201);
    const retryResult = await retryResponse.json();
    assert.equal(retryResult.success, true);
    assert.equal(retryResult.request.delivery_state, 'development-only');
    const communicationsAfterRetry = await storage.listCrmCommunications({
      submissionId: submission.id,
      page: 1,
      pageSize: 100,
    });
    assert.equal(communicationsAfterRetry.rows.filter((row) => row.cim_request_id === retryResult.request.id).length, 1);
    const replayedRetry = await fetch(`${origin}/api/admin/deal-hunter/cim-requests/${cimRequestId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ newRecipientEmail: 'corrected-boundary@example.com' }),
    });
    assert.equal(replayedRetry.status, 409);

    const viewerDisposition = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({ dealKey: 'http-boundary-deal', reason: 'not-a-fit', submissionId: submission.id }),
    });
    assert.equal(viewerDisposition.status, 401);
    const invalidDisposition = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ reason: 'not-a-fit' }),
    });
    assert.equal(invalidDisposition.status, 400);
    const canonicalWithoutScoreResponse = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        dealKey: 'http-boundary-deal',
        listingUrl: 'https://broker.example.test/http-boundary-deal',
        dealName: 'HTTP Lifecycle Boundary Services',
        reason: 'not-a-fit',
        note: 'Dismissed through the real HTTP boundary.',
        submissionId: submission.id,
      }),
    });
    assert.equal(canonicalWithoutScoreResponse.status, 409,
      'an active canonical record must not fall back around the current Inbox-score check');
    assert.match((await canonicalWithoutScoreResponse.json()).error, /no current Acquisition Inbox score/i);
    assert.equal((await storage.getSubmission(submission.id)).status, 'review');

    const legacyCreateResponse = await fetch(`${origin}/api/admin/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        company: 'HTTP Legacy Disposition Services',
        broker_name: 'Legacy Boundary Broker',
        broker_email: 'legacy-boundary@example.com',
        listing_url: 'https://broker.example.test/http-legacy-boundary-deal',
        lead_type: 'broker',
        status: 'review',
      }),
    });
    assert.equal(legacyCreateResponse.status, 201);
    const legacySubmission = (await legacyCreateResponse.json()).submission;
    const legacyDealKey = 'url:https://broker.example.test/http-legacy-boundary-deal';
    const dispositionRequestId = 'http-deal-hunter-disposition';
    const dispositionResponse = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-Request-ID': dispositionRequestId },
      body: JSON.stringify({
        dealKey: legacyDealKey,
        listingUrl: 'https://broker.example.test/http-legacy-boundary-deal',
        dealName: 'HTTP Legacy Disposition Services',
        reason: 'not-a-fit',
        note: 'Dismissed through the confined pre-Inbox fallback.',
        submissionId: legacySubmission.id,
      }),
    });
    assert.equal(dispositionResponse.status, 200);
    const dispositionResult = await dispositionResponse.json();
    assert.equal(dispositionResult.archived, true);
    assert.equal(dispositionResult.submission.status, 'archived');
    assert.equal(dispositionResult.disposition.deal_key, legacyDealKey);
    const repeatedDisposition = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ dealKey: legacyDealKey, reason: 'not-a-fit', submissionId: legacySubmission.id }),
    });
    assert.equal(repeatedDisposition.status, 200);

    const sourceOnlyDismiss = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        dealKey: 'http-source-only-deal',
        listingUrl: 'https://broker.example.test/http-source-only-deal',
        dealName: 'HTTP Source Only Services',
        reason: 'timing',
      }),
    });
    assert.equal(sourceOnlyDismiss.status, 200);
    const sourceOnlyDismissResult = await sourceOnlyDismiss.json();
    assert.equal(sourceOnlyDismissResult.archived, false);
    assert.equal(sourceOnlyDismissResult.submission, null);
    assert.equal(sourceOnlyDismissResult.disposition.disposition, 'dismissed');
    const sourceOnlyRestore = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ action: 'restore', dealKey: 'http-source-only-deal' }),
    });
    assert.equal(sourceOnlyRestore.status, 200);
    assert.equal((await sourceOnlyRestore.json()).disposition.disposition, 'restored');

    for (const [requestId, expectedStatus] of [
      [assignRequestId, 200],
      [retryRequestId, 201],
      [dispositionRequestId, 200],
    ]) {
      let events = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        events = await storage.listAdminAuditEvents({ requestId });
        if (events.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(events.map((event) => event.metadata.state).sort(), ['completed', 'started']);
      assert.equal(events.find((event) => event.metadata.state === 'completed').status_code, expectedStatus);
      assert.equal(events.find((event) => event.metadata.state === 'completed').actor, 'admin');
    }
  });
});

test('follow-up APIs paginate without bodies and enforce admin-only context, recommendation, and workflow actions', async () => {
  await withServer(async (origin) => {
    const adminCookie = lifecycleAdminCookie;
    const viewerCookie = lifecycleViewerCookie;
    assert.ok(adminCookie);
    assert.ok(viewerCookie);
    const created = [];
    for (let index = 0; index < 12; index += 1) {
      const response = await fetch(`${origin}/api/admin/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          company: `Followup Pagination Fixture ${String(index).padStart(2, '0')}`,
          seller_name: `Fixture Seller ${index}`,
          seller_email: `followup-pagination-${index}@example.test`,
          lead_type: 'seller',
          message: `Sensitive queue body ${index} must not appear in a queue response.`,
        }),
      });
      assert.equal(response.status, 201);
      created.push((await response.json()).submission);
    }

    const firstPageResponse = await fetch(
      `${origin}/api/admin/follow-ups?view=all&search=Followup%20Pagination%20Fixture&page=1&pageSize=10`,
      { headers: { Cookie: viewerCookie } },
    );
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPageResponse.status, 200);
    assert.match(firstPageResponse.headers.get('cache-control') || '', /no-store/);
    assert.equal(firstPage.total, 12);
    assert.equal(firstPage.items.length, 10);
    assert.equal(firstPage.totalPages, 2);
    assert.equal(Object.hasOwn(firstPage.items[0], 'message'), false);
    assert.equal(Object.hasOwn(firstPage.items[0], 'notes'), false);
    assert.equal(Object.hasOwn(firstPage.items[0], 'metadata'), false);
    assert.doesNotMatch(JSON.stringify(firstPage), /Sensitive queue body/);

    const secondPageResponse = await fetch(
      `${origin}/api/admin/follow-ups?view=all&search=Followup%20Pagination%20Fixture&page=2&pageSize=10`,
      { headers: { Cookie: viewerCookie } },
    );
    const secondPage = await secondPageResponse.json();
    assert.equal(secondPage.items.length, 2);

    const selected = created[0];
    const viewerContext = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/context`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerContext.status, 403);
    const viewerRecommendation = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: '{}',
    });
    assert.equal(viewerRecommendation.status, 403);

    const adminContext = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/context`, {
      headers: { Cookie: adminCookie },
    });
    const context = await adminContext.json();
    assert.equal(adminContext.status, 200);
    assert.equal(context.context.submission.id, selected.id);
    assert.deepEqual(context.context.communications, []);
    assert.equal(context.context.policy.email.enabled, false);

    const recommendationResponse = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: '{}',
    });
    const recommendation = await recommendationResponse.json();
    assert.equal(recommendationResponse.status, 200);
    assert.equal(recommendation.recommendation.metadata.sendAllowed, false);

    const previewResponse = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/email-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        expectedSubmissionVersion: selected.updated_at,
        recipient: selected.seller_email,
        subject: 'A safe preview',
        bodyText: 'This preview must not send.',
      }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 422);
    assert.equal(preview.code, 'email-disabled');

    const completeResponse = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/workflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ action: 'complete', expectedSubmissionVersion: selected.updated_at }),
    });
    const completed = await completeResponse.json();
    assert.equal(completeResponse.status, 200);
    assert.equal(completed.submission.follow_up_state, 'completed');

    const completedContextResponse = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/context`, {
      headers: { Cookie: adminCookie },
    });
    const completedContext = await completedContextResponse.json();
    assert.equal(completedContextResponse.status, 200);
    assert.equal(completedContext.context.recommendation, null, 'workflow mutation supersedes the prior recommendation');

    const staleResponse = await fetch(`${origin}/api/admin/follow-ups/${selected.id}/workflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ action: 'reopen', expectedSubmissionVersion: selected.updated_at }),
    });
    assert.equal(staleResponse.status, 409);
  });
});

test('required source authority blocks direct Acquisition Inbox decision mutation', async () => {
  const opportunityId = 'task-four-http-required-failure';
  const storage = await seedTaskFourOpportunity(opportunityId);
  writeTaskFourSourceSnapshot({ requiredHealthy: false });
  let digestRuns = 0;
  const app = createApp({ dailyDealHunterRunner: async () => { digestRuns += 1; return {}; } });

  await withServer(async (origin) => {
    const cookie = await signInForCookie(origin);
    const before = await storage.getCurrentDealHunterOpportunityScore(opportunityId);
    const response = await fetch(`${origin}/api/admin/deal-hunter/triage/${opportunityId}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ action: 'pursue' }),
    });
    const result = await response.json();
    const after = await storage.getCurrentDealHunterOpportunityScore(opportunityId);

    assert.equal(response.status, 503);
    assert.equal(result.success, false);
    assert.equal(result.code, 'required_source_authority_unavailable');
    assert.deepEqual(
      { priority: after.operator_priority, reviewedAt: after.reviewed_at, reviewedBy: after.reviewed_by },
      { priority: before.operator_priority, reviewedAt: before.reviewed_at, reviewedBy: before.reviewed_by },
    );
    assert.equal(digestRuns, 0);
  }, app);
});

test('optional Deal OS warning does not block a current primary-backed decision', async () => {
  const opportunityId = 'task-four-http-optional-warning';
  const storage = await seedTaskFourOpportunity(opportunityId);
  writeTaskFourSourceSnapshot({ requiredHealthy: true, optionalWarning: true });

  await withServer(async (origin) => {
    const cookie = await signInForCookie(origin);
    const response = await fetch(`${origin}/api/admin/deal-hunter/triage/${opportunityId}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ action: 'watch' }),
    });
    const result = await response.json();
    const after = await storage.getCurrentDealHunterOpportunityScore(opportunityId);

    assert.equal(response.status, 200);
    assert.equal(result.success, true);
    assert.equal(after.operator_priority, 'watch');
    assert.ok(after.reviewed_at);
  });
});

test('viewer can read but cannot mutate the Daily Digest briefing', async () => {
  const opportunityId = 'task-four-http-viewer';
  const storage = await seedTaskFourOpportunity(opportunityId);
  writeTaskFourSourceSnapshot({ requiredHealthy: true });

  await withServer(async (origin) => {
    const viewerCookie = await signInForCookie(origin, { username: 'smb-deal-hunter', password: 'view-only-local' });
    const read = await fetch(`${origin}/api/admin/deal-hunter/triage?view=needs-review`, { headers: { Cookie: viewerCookie } });
    const readResult = await read.json();
    assert.equal(read.status, 200);
    assert.equal(readResult.dailyDigest?.actionsAllowed, true);
    assert.equal(readResult.dailyDigest?.status, 'ready');

    const mutation = await fetch(`${origin}/api/admin/deal-hunter/triage/${opportunityId}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: viewerCookie }, body: JSON.stringify({ action: 'pursue' }),
    });
    const after = await storage.getCurrentDealHunterOpportunityScore(opportunityId);
    assert.equal(mutation.status, 401);
    assert.equal(after.operator_priority, 'normal');
    assert.equal(after.reviewed_at, null);
  });
});

const sourceAuthorityRequest = {
  sourceId: 'sheet-0',
  expectedPreviousRowCount: 871,
  expectedCurrentRowCount: 346,
  expectedSnapshotSha256: 'a'.repeat(64),
  expectedSourceFingerprint: 'b'.repeat(64),
  confirmation: 'ACCEPT_REQUIRED_SOURCE_POPULATION_REDUCTION',
  reasonCode: 'business-confirmed-active-population-reset',
};

const sourceAuthoritySuccess = {
  sourceId: 'sheet-0',
  previousRowCount: 871,
  acceptedRowCount: 346,
  sourceFingerprint: 'b'.repeat(64),
  previousSnapshotSha256: 'a'.repeat(64),
  newSnapshotSha256: 'c'.repeat(64),
  backupId: '20260909T163000000Z-a1b2c3d4-bounded',
  acceptedAt: '2026-09-09T16:30:00.000Z',
  reasonCode: 'business-confirmed-active-population-reset',
  targetSourceHealthy: true,
};

function sourceAuthorityHttpError(status, code) {
  const error = new Error('Bounded source-authority request rejected.');
  error.name = 'RequiredSourceAuthorityRevalidationError';
  error.status = status;
  error.code = code;
  return error;
}

test('administrator can invoke the exact required-source authority revalidation contract', async () => {
  let received = null;
  const app = createApp({
    sourceAuthorityRevalidator: async (request) => {
      received = request;
      return sourceAuthoritySuccess;
    },
  });

  await withServer(async (origin) => {
    const adminCookie = await signInForCookie(origin);
    const response = await fetch(`${origin}/api/admin/deal-hunter/source-authority/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(sourceAuthorityRequest),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(result, { success: true, ...sourceAuthoritySuccess });
    assert.deepEqual(received.input, sourceAuthorityRequest);
    assert.equal(received.actor.role, 'admin');
    assert.equal(received.actor.principal_id, 'admin:primary');
    assert.equal('actor' in received.input, false);
  }, app);
});

test('required-source authority revalidation rejects viewer and unauthenticated callers before service execution', async () => {
  let serviceCalls = 0;
  const app = createApp({
    sourceAuthorityRevalidator: async () => {
      serviceCalls += 1;
      return sourceAuthoritySuccess;
    },
  });

  await withServer(async (origin) => {
    const viewerCookie = await signInForCookie(origin, { username: 'smb-deal-hunter', password: 'view-only-local' });
    for (const headers of [
      { 'Content-Type': 'application/json', Cookie: viewerCookie },
      { 'Content-Type': 'application/json' },
    ]) {
      const response = await fetch(`${origin}/api/admin/deal-hunter/source-authority/revalidate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(sourceAuthorityRequest),
      });
      assert.equal(response.status, 401);
    }
    assert.equal(serviceCalls, 0);
  }, app);
});

test('required-source authority HTTP schema rejects unknown fields and the wrong confirmation before service execution', async () => {
  let serviceCalls = 0;
  const app = createApp({
    sourceAuthorityRevalidator: async () => {
      serviceCalls += 1;
      return sourceAuthoritySuccess;
    },
  });

  await withServer(async (origin) => {
    const adminCookie = await signInForCookie(origin);
    const invalidBodies = [
      { ...sourceAuthorityRequest, actor: 'caller-controlled' },
      { ...sourceAuthorityRequest, confirmation: 'accept' },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(`${origin}/api/admin/deal-hunter/source-authority/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 400);
      assert.equal(result.success, false);
    }
    assert.equal(serviceCalls, 0);
  }, app);
});

test('required-source authority HTTP route returns conflicts for stale SHA, fingerprint, and changed live count', async (t) => {
  const cases = [
    ['stale snapshot SHA', 'source_authority_snapshot_conflict'],
    ['wrong source fingerprint', 'source_authority_fingerprint_conflict'],
    ['live count changed', 'source_authority_current_count_conflict'],
  ];

  for (const [label, code] of cases) {
    await t.test(label, async () => {
      let serviceCalls = 0;
      const app = createApp({
        sourceAuthorityRevalidator: async () => {
          serviceCalls += 1;
          throw sourceAuthorityHttpError(409, code);
        },
      });
      await withServer(async (origin) => {
        const adminCookie = await signInForCookie(origin);
        const response = await fetch(`${origin}/api/admin/deal-hunter/source-authority/revalidate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(sourceAuthorityRequest),
        });
        const result = await response.json();
        assert.equal(response.status, 409);
        assert.equal(result.success, false);
        assert.equal(result.code, code);
        assert.equal(serviceCalls, 1);
      }, app);
    });
  }
});

test('required-source authority success response is an exact bounded privacy projection', async () => {
  const app = createApp({ sourceAuthorityRevalidator: async () => sourceAuthoritySuccess });

  await withServer(async (origin) => {
    const adminCookie = await signInForCookie(origin);
    const response = await fetch(`${origin}/api/admin/deal-hunter/source-authority/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify(sourceAuthorityRequest),
    });
    const result = await response.json();
    const serialized = JSON.stringify(result).toLowerCase();

    assert.deepEqual(Object.keys(result).sort(), [
      'acceptedAt',
      'acceptedRowCount',
      'backupId',
      'newSnapshotSha256',
      'previousRowCount',
      'previousSnapshotSha256',
      'reasonCode',
      'sourceFingerprint',
      'sourceId',
      'success',
      'targetSourceHealthy',
    ].sort());
    for (const forbidden of [
      'docs.google.com', 'snapshot contents', 'private row', 'secret', 'recipient', 'provider', 'sender', 'claim token',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  }, app);
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
