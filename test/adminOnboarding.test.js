import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ADMIN_ONBOARDING_STATUSES,
  adminOnboardingTours,
  getAdminOnboardingStepIds,
  getAdminOnboardingTour,
  isAdminOnboardingRoleEligible,
} from '../shared/adminOnboarding.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { createSupabaseStorage } from '../server/storage/supabase.js';
import {
  AdminOnboardingRequestError,
  listAdminOnboardingProgressForSession,
  updateAdminOnboardingProgressForSession,
} from '../server/services/adminOnboarding.js';
import { registerAdminOnboardingRoutes } from '../server/routes/adminOnboarding.js';

function createMemoryOnboardingStorage(seed = []) {
  const rows = seed.map((row) => ({ ...row }));
  return {
    rows,
    async listAdminOnboardingProgress(principalId) {
      return rows.filter((row) => row.principal_id === principalId).map((row) => ({ ...row }));
    },
    async upsertAdminOnboardingProgress(record) {
      const index = rows.findIndex((row) => (
        row.principal_id === record.principal_id
        && row.tour_key === record.tour_key
        && row.tour_version === record.tour_version
      ));
      if (index >= 0) rows[index] = { ...record };
      else rows.push({ ...record });
      return { ...record };
    },
  };
}

async function assertOnboardingError(run, { status, code }) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof AdminOnboardingRequestError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

function createOnboardingRouteHarness(dependencies) {
  const handlers = new Map();
  const app = {
    get(pathname, handler) { handlers.set(`get:${pathname}`, handler); },
    patch(pathname, handler) { handlers.set(`patch:${pathname}`, handler); },
  };
  registerAdminOnboardingRoutes(app, dependencies);
  return handlers;
}

async function invokeOnboardingRoute(handlers, {
  method,
  routePath,
  session = null,
  body = {},
  params = {},
}) {
  const handler = handlers.get(`${method}:${routePath}`);
  assert.ok(handler, `${method.toUpperCase()} ${routePath} route should exist`);
  const request = {
    adminSession: session,
    body,
    headers: { host: 'localhost' },
    ip: '127.0.0.1',
    method: method.toUpperCase(),
    params,
    query: {},
    socket: {},
  };
  const response = {
    body: null,
    headers: {},
    statusCode: 200,
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
  };
  let routeError = null;
  await handler(request, response, (error) => { routeError = error; });
  if (routeError) throw routeError;
  return response;
}

test('shared onboarding registry bounds current tour, role, version, and stable step identities', () => {
  assert.deepEqual(Object.keys(adminOnboardingTours), [
    'admin-foundations',
    'crm-index',
    'crm-detail',
    'command-center',
    'deal-hunter',
    'follow-ups',
    'operations',
    'new-record',
  ]);
  assert.deepEqual(ADMIN_ONBOARDING_STATUSES, ['in_progress', 'completed', 'skipped']);

  for (const [tourKey, tour] of Object.entries(adminOnboardingTours)) {
    assert.equal(tour.key, tourKey);
    assert.ok(Number.isSafeInteger(tour.version) && tour.version > 0);
    assert.ok(tour.roles.length > 0);
    assert.ok(tour.steps.length > 0);
    assert.equal(new Set(tour.steps.map((step) => step.id)).size, tour.steps.length);
    assert.deepEqual(getAdminOnboardingTour(tourKey), tour);
    assert.equal(getAdminOnboardingTour(`${tourKey}-unknown`), null);
  }

  assert.equal(isAdminOnboardingRoleEligible('operations', 'admin'), true);
  assert.equal(isAdminOnboardingRoleEligible('operations', 'viewer'), false);
  assert.equal(isAdminOnboardingRoleEligible('new-record', 'viewer'), false);
  assert.ok(getAdminOnboardingStepIds('deal-hunter', 'admin').includes('deal-hunter-cim-workflow'));
  assert.ok(!getAdminOnboardingStepIds('deal-hunter', 'viewer').includes('deal-hunter-cim-workflow'));
  assert.ok(getAdminOnboardingStepIds('follow-ups', 'admin').includes('follow-ups-email-controls'));
  assert.ok(!getAdminOnboardingStepIds('follow-ups', 'viewer').includes('follow-ups-email-controls'));
});

test('production image includes the shared onboarding contract used by the server', async () => {
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

  assert.match(
    dockerfile,
    /COPY --from=build \/app\/shared \.\/shared/,
    'the runtime image must include modules imported from the top-level shared directory',
  );
});

test('SQLite creates, reopens, lists, and atomically transitions onboarding progress', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uckele-admin-onboarding-'));
  const sqlitePath = path.join(directory, 'onboarding.sqlite');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const initial = createSqliteStorage({ storage: { sqlitePath } });
  await initial.insertAdminSession({
    id: 'preserved-admin-session',
    created_at: '2026-08-10T09:00:00.000Z',
    expires_at: '2026-08-11T09:00:00.000Z',
    last_seen_at: '2026-08-10T09:00:00.000Z',
    username: 'preserved-admin',
    principal_id: 'admin:primary',
    role: 'admin',
    created_ip_hash: null,
    user_agent: 'onboarding-migration-test',
    metadata: { preserved: true },
  });
  const started = await initial.upsertAdminOnboardingProgress({
    principal_id: 'viewer:identity:one@example.com',
    tour_key: 'admin-foundations',
    tour_version: 1,
    status: 'in_progress',
    last_completed_step_id: 'foundations-welcome',
    started_at: '2026-08-10T10:00:00.000Z',
    updated_at: '2026-08-10T10:00:00.000Z',
    completed_at: null,
    skipped_at: null,
  });
  assert.equal(started.status, 'in_progress');
  initial.close();

  const reopened = createSqliteStorage({ storage: { sqlitePath } });
  assert.equal((await reopened.getAdminSession('preserved-admin-session')).principal_id, 'admin:primary');
  assert.deepEqual(await reopened.listAdminOnboardingProgress('admin:primary'), []);
  assert.equal((await reopened.listAdminOnboardingProgress('viewer:identity:one@example.com')).length, 1);

  const advanced = await reopened.upsertAdminOnboardingProgress({
    ...started,
    last_completed_step_id: 'foundations-overview-priorities',
    valid_step_ids: getAdminOnboardingStepIds('admin-foundations', 'viewer'),
    updated_at: '2026-08-10T10:00:30.000Z',
  });
  const staleStep = await reopened.upsertAdminOnboardingProgress({
    ...advanced,
    last_completed_step_id: 'foundations-section-navigation',
    valid_step_ids: getAdminOnboardingStepIds('admin-foundations', 'viewer'),
    updated_at: '2026-08-10T10:00:45.000Z',
  });
  assert.equal(staleStep.last_completed_step_id, 'foundations-overview-priorities');
  assert.equal(staleStep.updated_at, advanced.updated_at);

  const skipped = await reopened.upsertAdminOnboardingProgress({
    ...advanced,
    valid_step_ids: getAdminOnboardingStepIds('admin-foundations', 'viewer'),
    status: 'skipped',
    updated_at: '2026-08-10T10:01:00.000Z',
    completed_at: null,
    skipped_at: '2026-08-10T10:01:00.000Z',
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.completed_at, null);

  const ignoredReplayStart = await reopened.upsertAdminOnboardingProgress({
    ...skipped,
    status: 'in_progress',
    updated_at: '2026-08-10T10:02:00.000Z',
    completed_at: null,
    skipped_at: null,
  });
  assert.deepEqual(ignoredReplayStart, skipped);

  const completed = await reopened.upsertAdminOnboardingProgress({
    ...skipped,
    status: 'completed',
    last_completed_step_id: 'foundations-page-guide',
    updated_at: '2026-08-10T10:03:00.000Z',
    completed_at: '2026-08-10T10:03:00.000Z',
    skipped_at: null,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.skipped_at, null);

  const ignoredDowngrade = await reopened.upsertAdminOnboardingProgress({
    ...completed,
    status: 'skipped',
    updated_at: '2026-08-10T10:04:00.000Z',
    completed_at: null,
    skipped_at: '2026-08-10T10:04:00.000Z',
  });
  assert.deepEqual(ignoredDowngrade, completed);

  await reopened.upsertAdminOnboardingProgress({
    ...started,
    tour_version: 2,
    status: 'completed',
    updated_at: '2026-08-10T10:05:00.000Z',
    completed_at: '2026-08-10T10:05:00.000Z',
  });
  const rows = await reopened.listAdminOnboardingProgress('viewer:identity:one@example.com');
  assert.equal(rows.length, 2);
  reopened.close();
});

test('Supabase onboarding storage returns the same normalized shape and uses the atomic RPC', async () => {
  const databaseRow = {
    principal_id: 'admin:primary',
    tour_key: 'admin-foundations',
    tour_version: '1',
    status: 'completed',
    last_completed_step_id: 'foundations-page-guide',
    started_at: '2026-08-10T10:00:00.000Z',
    updated_at: '2026-08-10T10:03:00.000Z',
    completed_at: '2026-08-10T10:03:00.000Z',
    skipped_at: null,
  };
  const rpcCalls = [];
  let orderCalls = 0;
  const query = {
    select() { return this; },
    eq(field, value) {
      assert.equal(field, 'principal_id');
      assert.equal(value, 'admin:primary');
      return this;
    },
    order() {
      orderCalls += 1;
      return orderCalls === 3 ? Promise.resolve({ data: [databaseRow], error: null }) : this;
    },
  };
  const client = {
    from(table) {
      assert.equal(table, 'admin_onboarding_progress');
      return query;
    },
    async rpc(name, params) {
      rpcCalls.push({ name, params });
      return { data: databaseRow, error: null };
    },
  };
  const storage = createSupabaseStorage({ storage: {} }, { client });
  const expected = { ...databaseRow, tour_version: 1 };

  assert.deepEqual(await storage.listAdminOnboardingProgress('admin:primary'), [expected]);
  assert.deepEqual(await storage.upsertAdminOnboardingProgress(expected), expected);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'upsert_admin_onboarding_progress');
  assert.deepEqual(Object.keys(rpcCalls[0].params).sort(), [
    'p_completed_at',
    'p_last_completed_step_id',
    'p_principal_id',
    'p_skipped_at',
    'p_started_at',
    'p_status',
    'p_step_ids',
    'p_tour_key',
    'p_tour_version',
    'p_updated_at',
  ]);
});

test('onboarding service validates bounded input and scopes every read/write to the session principal', async () => {
  const storage = createMemoryOnboardingStorage([
    {
      principal_id: 'admin:primary',
      tour_key: 'admin-foundations',
      tour_version: 1,
      status: 'completed',
      last_completed_step_id: 'foundations-page-guide',
      started_at: '2026-08-10T09:00:00.000Z',
      updated_at: '2026-08-10T09:05:00.000Z',
      completed_at: '2026-08-10T09:05:00.000Z',
      skipped_at: null,
    },
    {
      principal_id: 'viewer:identity:viewer@example.com',
      tour_key: 'admin-foundations',
      tour_version: 0,
      status: 'completed',
      last_completed_step_id: null,
      started_at: '2026-08-09T09:00:00.000Z',
      updated_at: '2026-08-09T09:05:00.000Z',
      completed_at: '2026-08-09T09:05:00.000Z',
      skipped_at: null,
    },
  ]);
  const viewerSession = {
    principal_id: 'viewer:identity:viewer@example.com',
    username: 'viewer@example.com',
    role: 'viewer',
  };
  const adminSession = { principal_id: 'admin:primary', username: 'admin', role: 'admin' };

  assert.deepEqual(await listAdminOnboardingProgressForSession(viewerSession, { storage }), []);
  assert.equal((await listAdminOnboardingProgressForSession(adminSession, { storage })).length, 1);

  const saved = await updateAdminOnboardingProgressForSession(
    viewerSession,
    'admin-foundations',
    {
      tourVersion: 1,
      status: 'in_progress',
      lastCompletedStepId: 'foundations-overview-priorities',
    },
    { storage, now: () => new Date('2026-08-10T12:00:00.000Z') },
  );
  assert.equal(saved.tourKey, 'admin-foundations');
  assert.equal(saved.lastCompletedStepId, 'foundations-overview-priorities');
  assert.equal(storage.rows.at(-1).principal_id, viewerSession.principal_id);
  assert.equal(Object.hasOwn(saved, 'principal_id'), false);

  await assertOnboardingError(
    () => updateAdminOnboardingProgressForSession(viewerSession, 'operations', {
      tourVersion: 1,
      status: 'in_progress',
    }, { storage }),
    { status: 403, code: 'role_ineligible' },
  );
  await assertOnboardingError(
    () => updateAdminOnboardingProgressForSession(viewerSession, 'unknown-tour', {
      tourVersion: 1,
      status: 'in_progress',
    }, { storage }),
    { status: 400, code: 'unknown_tour' },
  );
  await assertOnboardingError(
    () => updateAdminOnboardingProgressForSession(viewerSession, 'admin-foundations', {
      tourVersion: 2,
      status: 'in_progress',
    }, { storage }),
    { status: 400, code: 'unsupported_version' },
  );
  await assertOnboardingError(
    () => updateAdminOnboardingProgressForSession(viewerSession, 'admin-foundations', {
      tourVersion: 1,
      status: 'paused',
    }, { storage }),
    { status: 400, code: 'invalid_status' },
  );
  await assertOnboardingError(
    () => updateAdminOnboardingProgressForSession(viewerSession, 'deal-hunter', {
      tourVersion: 1,
      status: 'in_progress',
      lastCompletedStepId: 'deal-hunter-cim-workflow',
    }, { storage }),
    { status: 400, code: 'invalid_step' },
  );
  await assertOnboardingError(
    () => updateAdminOnboardingProgressForSession(viewerSession, 'admin-foundations', {
      tourVersion: 1,
      status: 'in_progress',
      principalId: 'admin:primary',
    }, { storage }),
    { status: 400, code: 'invalid_body' },
  );
  await assertOnboardingError(
    () => updateAdminOnboardingProgressForSession(viewerSession, 'crm-index', {
      tourVersion: 1,
      status: 'completed',
    }, { storage }),
    { status: 400, code: 'invalid_step' },
  );
});

test('onboarding service preserves terminal state and allows skipped progress to upgrade to completed', async (t) => {
  const session = { principal_id: 'admin:primary', username: 'admin', role: 'admin' };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uckele-admin-onboarding-service-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'service.sqlite') } });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const clock = [
    '2026-08-10T13:00:00.000Z',
    '2026-08-10T13:01:00.000Z',
    '2026-08-10T13:02:00.000Z',
    '2026-08-10T13:03:00.000Z',
    '2026-08-10T13:04:00.000Z',
  ];
  const now = () => new Date(clock.shift());

  await updateAdminOnboardingProgressForSession(session, 'admin-foundations', {
    tourVersion: 1,
    status: 'in_progress',
  }, { storage, now });
  const skipped = await updateAdminOnboardingProgressForSession(session, 'admin-foundations', {
    tourVersion: 1,
    status: 'skipped',
    lastCompletedStepId: 'foundations-section-navigation',
  }, { storage, now });
  const replayStart = await updateAdminOnboardingProgressForSession(session, 'admin-foundations', {
    tourVersion: 1,
    status: 'in_progress',
  }, { storage, now });
  assert.deepEqual(replayStart, skipped);

  const completed = await updateAdminOnboardingProgressForSession(session, 'admin-foundations', {
    tourVersion: 1,
    status: 'completed',
    lastCompletedStepId: 'foundations-page-guide',
  }, { storage, now });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.skippedAt, null);

  const downgrade = await updateAdminOnboardingProgressForSession(session, 'admin-foundations', {
    tourVersion: 1,
    status: 'skipped',
  }, { storage, now });
  assert.deepEqual(downgrade, completed);
  assert.equal((await storage.listAdminOnboardingProgress('admin:primary')).length, 1);
  storage.close();
});

test('onboarding API authenticates, rejects spoofing, enforces role eligibility, and returns only self-scoped progress', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uckele-admin-onboarding-api-'));
  const storage = createSqliteStorage({ storage: { sqlitePath: path.join(directory, 'api.sqlite') } });
  t.after(async () => {
    storage.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const viewerSession = {
    id: 'viewer-session',
    principal_id: 'viewer:identity:viewer@example.com',
    username: 'viewer@example.com',
    role: 'viewer',
  };
  const adminSession = {
    id: 'admin-session',
    principal_id: 'admin:primary',
    username: 'admin',
    role: 'admin',
  };
  const handlers = createOnboardingRouteHarness({
    requireAccess: async (request) => request.adminSession || null,
    listProgress: (session) => listAdminOnboardingProgressForSession(session, { storage }),
    updateProgress: (session, tourKey, body) => updateAdminOnboardingProgressForSession(
      session,
      tourKey,
      body,
      { storage },
    ),
  });

  const unauthenticatedGet = await invokeOnboardingRoute(handlers, {
    method: 'get',
    routePath: '/api/admin/onboarding',
  });
  assert.equal(unauthenticatedGet.statusCode, 401);
  assert.equal(unauthenticatedGet.body.code, 'unauthenticated');

  const unauthenticatedPatch = await invokeOnboardingRoute(handlers, {
    method: 'patch',
    routePath: '/api/admin/onboarding/:tourKey',
    params: { tourKey: 'admin-foundations' },
    body: { tourVersion: 1, status: 'in_progress' },
  });
  assert.equal(unauthenticatedPatch.statusCode, 401);

  const spoofed = await invokeOnboardingRoute(handlers, {
    method: 'patch',
    routePath: '/api/admin/onboarding/:tourKey',
    session: viewerSession,
    params: { tourKey: 'admin-foundations' },
    body: {
      tourVersion: 1,
      status: 'completed',
      principalId: 'admin:primary',
      completedAt: '2026-08-10T00:00:00.000Z',
    },
  });
  assert.equal(spoofed.statusCode, 400);
  assert.equal(spoofed.body.code, 'invalid_body');

  const forbidden = await invokeOnboardingRoute(handlers, {
    method: 'patch',
    routePath: '/api/admin/onboarding/:tourKey',
    session: viewerSession,
    params: { tourKey: 'operations' },
    body: { tourVersion: 1, status: 'in_progress' },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.code, 'role_ineligible');

  const saved = await invokeOnboardingRoute(handlers, {
    method: 'patch',
    routePath: '/api/admin/onboarding/:tourKey',
    session: viewerSession,
    params: { tourKey: 'admin-foundations' },
    body: {
      tourVersion: 1,
      status: 'in_progress',
      lastCompletedStepId: 'foundations-welcome',
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.progress.lastCompletedStepId, 'foundations-welcome');
  assert.equal(JSON.stringify(saved.body).includes('viewer@example.com'), false);

  const timestamp = '2026-08-10T15:00:00.000Z';
  await storage.upsertAdminOnboardingProgress({
    principal_id: adminSession.principal_id,
    tour_key: 'admin-foundations',
    tour_version: 1,
    status: 'completed',
    last_completed_step_id: 'foundations-page-guide',
    started_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp,
    skipped_at: null,
  });

  const viewerList = await invokeOnboardingRoute(handlers, {
    method: 'get',
    routePath: '/api/admin/onboarding',
    session: viewerSession,
  });
  assert.equal(viewerList.statusCode, 200);
  assert.equal(viewerList.body.progress.length, 1);
  assert.equal(viewerList.body.progress[0].status, 'in_progress');

  const adminList = await invokeOnboardingRoute(handlers, {
    method: 'get',
    routePath: '/api/admin/onboarding',
    session: adminSession,
  });
  assert.equal(adminList.body.progress.length, 1);
  assert.equal(adminList.body.progress[0].status, 'completed');
});
