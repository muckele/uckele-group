import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-http-app-'));
process.env.ADMIN_SESSION_SECRET = 'http-app-session-secret-for-tests';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'http-app-document-secret-for-tests';
process.env.SQLITE_PATH = path.join(tempDir, 'http-app.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');
process.env.DEAL_HUNTER_SHEET_CSV_URL = '';
delete process.env.DEAL_HUNTER_SHEET_CSV_URLS;

const { createApp } = await import('../server/app.js');
const { createSecureUploadRequest } = await import('../server/services/documentVault.js');
const { createManualSubmission } = await import('../server/services/submissions.js');
const { getStorage } = await import('../server/storage/index.js');
let lifecycleAdminCookie = '';
let lifecycleViewerCookie = '';

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
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
    const dispositionRequestId = 'http-deal-hunter-disposition';
    const dispositionResponse = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie, 'X-Request-ID': dispositionRequestId },
      body: JSON.stringify({
        dealKey: 'http-boundary-deal',
        listingUrl: 'https://broker.example.test/http-boundary-deal',
        dealName: 'HTTP Lifecycle Boundary Services',
        reason: 'not-a-fit',
        note: 'Dismissed through the real HTTP boundary.',
        submissionId: submission.id,
      }),
    });
    assert.equal(dispositionResponse.status, 200);
    const dispositionResult = await dispositionResponse.json();
    assert.equal(dispositionResult.archived, true);
    assert.equal(dispositionResult.submission.status, 'archived');
    assert.equal(dispositionResult.disposition.deal_key, 'http-boundary-deal');
    const repeatedDisposition = await fetch(`${origin}/api/admin/deal-hunter/dispositions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ dealKey: 'http-boundary-deal', reason: 'not-a-fit', submissionId: submission.id }),
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

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
