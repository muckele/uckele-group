import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

function routeLayer(app, method, routePath) {
  return app._router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method]);
}

async function invokeRoute(app, { method, routePath, cookie = '', body = {}, params = {}, query = {} }) {
  const layer = routeLayer(app, method, routePath);

  assert.ok(layer, `${method.toUpperCase()} ${routePath} route should exist`);

  const request = {
    body,
    headers: {
      cookie,
      host: 'localhost',
    },
    ip: '127.0.0.1',
    method: method.toUpperCase(),
    params,
    query,
    socket: {},
  };
  const response = {
    body: undefined,
    headers: {},
    statusCode: 200,
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
  let routeError = null;

  await layer.route.stack.at(-1).handle(request, response, (error) => {
    routeError = error;
  });

  if (routeError) {
    throw routeError;
  }

  return response;
}

test('viewer credentials create read-only admin access', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-admin-auth-'));

  process.env.ADMIN_AUTH_MODE = 'hybrid';
  process.env.ADMIN_ALLOW_PASSWORD_AUTH = 'true';
  process.env.ADMIN_USERNAME = 'admin-test';
  process.env.ADMIN_PASSWORD = 'admin-password';
  process.env.ADMIN_VIEWER_USERNAME = 'viewer-test';
  process.env.ADMIN_VIEWER_PASSWORD = 'viewer-password';
  process.env.ADMIN_VIEWER_EMAILS = 'viewer@example.com';
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_MAGIC_LINK_SECRET = 'test-magic-secret';
  process.env.DELIVERY_PROVIDER = 'console';
  const sqlitePath = path.join(tempDir, 'auth.sqlite');
  process.env.SQLITE_PATH = sqlitePath;

  const legacyDatabase = new Database(sqlitePath);
  const legacyCreatedAt = new Date().toISOString();
  const legacyExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  legacyDatabase.exec(`
    CREATE TABLE admin_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      created_ip_hash TEXT,
      user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  const insertLegacySession = legacyDatabase.prepare(`
    INSERT INTO admin_sessions (
      id, created_at, expires_at, last_seen_at, revoked_at, username, role,
      created_ip_hash, user_agent, metadata
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, '', 'legacy-test', '{}')
  `);
  insertLegacySession.run('legacy-admin-password', legacyCreatedAt, legacyExpiresAt, legacyCreatedAt, 'admin-test', 'admin');
  insertLegacySession.run('legacy-admin-magic-link', legacyCreatedAt, legacyExpiresAt, legacyCreatedAt, 'admin@example.com', 'admin');
  legacyDatabase.close();

  const {
    cleanupExpiredAuthRecords,
    getAdminAuthState,
    loginAdmin,
    requestAdminMagicLink,
    requireAdmin,
    requireAdminAccess,
    verifyAdminMagicLink,
  } = await import('../server/services/auth.js');
  const { getStorage } = await import('../server/storage/index.js');
  const { signPayload } = await import('../server/utils/security.js');
  const { createApp } = await import('../server/app.js');
  const request = { headers: {}, ip: '127.0.0.1' };

  const adminLogin = await loginAdmin('admin-test', 'admin-password', request);
  assert.equal(adminLogin.ok, true);
  assert.equal(adminLogin.session.role, 'admin');
  assert.equal(adminLogin.session.username, 'admin-test');
  assert.equal(adminLogin.session.metadata.auth_method, 'password');
  assert.equal((await requireAdmin({ headers: { cookie: adminLogin.cookie } }))?.role, 'admin');
  assert.equal((await requireAdminAccess({ headers: { cookie: adminLogin.cookie } }))?.role, 'admin');

  const viewerLogin = await loginAdmin('viewer-test', 'viewer-password', request);
  assert.equal(viewerLogin.ok, true);
  assert.equal(viewerLogin.session.role, 'viewer');
  assert.equal(await requireAdmin({ headers: { cookie: viewerLogin.cookie } }), null);
  assert.equal((await requireAdminAccess({ headers: { cookie: viewerLogin.cookie } }))?.role, 'viewer');

  const authState = getAdminAuthState();
  assert.equal(authState.passwordEnabled, true);
  assert.equal(authState.viewerAccessEnabled, true);

  const unknownMagicLink = await requestAdminMagicLink('unknown@example.com', request);
  const originalConsoleLog = console.log;
  let viewerMagicLink;

  try {
    console.log = () => {};
    viewerMagicLink = await requestAdminMagicLink('viewer@example.com', request);
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(viewerMagicLink.ok, true);
  assert.equal(unknownMagicLink.message, viewerMagicLink.message);

  const magicToken = new URL(viewerMagicLink.previewUrl).searchParams.get('admin_token');
  const firstMagicVerification = await verifyAdminMagicLink(magicToken);
  const replayedMagicVerification = await verifyAdminMagicLink(magicToken);
  assert.equal(firstMagicVerification.ok, true);
  assert.equal(firstMagicVerification.session.role, 'viewer');
  assert.equal(replayedMagicVerification.ok, false);
  assert.match(replayedMagicVerification.reason, /already been used|invalid/i);

  let adminMagicLink;
  try {
    console.log = () => {};
    adminMagicLink = await requestAdminMagicLink('admin@example.com', request);
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(adminMagicLink.ok, true);
  const adminMagicToken = new URL(adminMagicLink.previewUrl).searchParams.get('admin_token');
  const adminMagicVerification = await verifyAdminMagicLink(adminMagicToken);
  assert.equal(adminMagicVerification.ok, true);
  assert.equal(adminMagicVerification.session.role, 'admin');
  assert.equal(adminMagicVerification.session.username, 'admin@example.com');
  assert.equal(adminMagicVerification.session.metadata.auth_method, 'magic-link');
  assert.equal(adminMagicVerification.session.principal_id, adminLogin.session.principal_id);

  const storage = getStorage();
  assert.equal((await storage.getAdminSession('legacy-admin-password')).principal_id, 'admin:primary');
  assert.equal((await storage.getAdminSession('legacy-admin-magic-link')).principal_id, 'admin:primary');
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  await storage.insertAdminSession({
    id: 'expired-session-test',
    created_at: expiredAt,
    expires_at: expiredAt,
    last_seen_at: expiredAt,
    username: 'viewer-test',
    principal_id: 'viewer:identity:viewer-test',
    role: 'viewer',
    created_ip_hash: '',
    user_agent: 'test',
    metadata: {},
  });
  await storage.insertAdminMagicLink({
    token_hash: 'expired-magic-link-test',
    created_at: expiredAt,
    expires_at: expiredAt,
    email: 'viewer@example.com',
    role: 'viewer',
    requested_ip_hash: '',
    metadata: {},
  });
  const cleanupResult = await cleanupExpiredAuthRecords(storage);
  assert.ok(cleanupResult.sessions >= 1);
  assert.ok(cleanupResult.magicLinks >= 2, 'expired and consumed magic links should be removed');
  assert.equal(await storage.getAdminSession('expired-session-test'), null);

  const app = createApp();
  const viewerCookie = viewerLogin.cookie;
  const unsupportedRoleCookie = `ug_admin_session=${signPayload(
    {
      role: 'editor',
      username: 'editor-test',
      exp: Date.now() + 60_000,
    },
    'test-session-secret',
  )}`;
  const unsupportedSessionResponse = await invokeRoute(app, {
    method: 'get',
    routePath: '/api/admin/session',
    cookie: unsupportedRoleCookie,
  });

  assert.equal(unsupportedSessionResponse.statusCode, 200);
  assert.equal(unsupportedSessionResponse.body.authenticated, false);

  const readResponse = await invokeRoute(app, {
    method: 'get',
    routePath: '/api/admin/submissions',
    cookie: viewerCookie,
  });

  assert.equal(readResponse.statusCode, 200);
  assert.equal(readResponse.body.success, true);

  const followUpsResponse = await invokeRoute(app, {
    method: 'get',
    routePath: '/api/admin/follow-ups',
    cookie: viewerCookie,
  });

  assert.equal(followUpsResponse.statusCode, 200);
  assert.equal(followUpsResponse.body.success, true);
  const viewerOperationsResponse = await invokeRoute(app, {
    method: 'get',
    routePath: '/api/admin/operations',
    cookie: viewerCookie,
  });
  assert.equal(viewerOperationsResponse.statusCode, 200);
  assert.equal(viewerOperationsResponse.body.success, true);
  assert.equal(viewerOperationsResponse.body.operations.viewerAggregateOnly, true);
  assert.deepEqual(viewerOperationsResponse.body.operations.audit.events, []);
  assert.deepEqual(viewerOperationsResponse.body.operations.email.allowedTestRecipients, []);
  assert.equal(routeLayer(app, 'get', '/api/admin/prospect-discovery'), undefined);
  assert.equal(routeLayer(app, 'post', '/api/admin/prospect-discovery/run'), undefined);

  const blockedRoutes = [
    { method: 'post', routePath: '/api/admin/acquisition-command-center/:id', params: { id: 'submission-1' }, body: { pipelineStage: 'passed' } },
    { method: 'post', routePath: '/api/admin/submissions', body: { name: 'Viewer Attempt' } },
    { method: 'get', routePath: '/api/admin/submissions/export' },
    { method: 'post', routePath: '/api/admin/deal-hunter/send' },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-request', body: { dealKey: 'deal-1' } },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-requests/send-ready' },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-reviews' },
    { method: 'get', routePath: '/api/admin/deal-hunter/cim-stage2/review-queue' },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-stage2/review-decisions' },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-automation/pause' },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-stage2/activation', body: { mode: 'canary' } },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-stage2/run', body: { mode: 'shadow' } },
    { method: 'get', routePath: '/api/admin/deal-hunter/cim-stage2/runs/:id/decisions', params: { id: 'stage2-run' } },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-outcomes' },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-follow-ups/run' },
    { method: 'post', routePath: '/api/admin/email/test' },
    { method: 'patch', routePath: '/api/admin/submissions/:id', params: { id: 'submission-1' }, body: { status: 'review' } },
    { method: 'delete', routePath: '/api/admin/submissions/:id', params: { id: 'submission-1' } },
    { method: 'post', routePath: '/api/admin/submissions/:id/upload-request', params: { id: 'submission-1' } },
    { method: 'get', routePath: '/api/admin/secure-documents/:id/download', params: { id: 'document-1' } },
  ];

  for (const route of blockedRoutes) {
    const response = await invokeRoute(app, {
      ...route,
      cookie: viewerCookie,
    });

    assert.equal(response.statusCode, 401, `${route.method.toUpperCase()} ${route.routePath} should reject viewer access`);
    assert.match(response.body.error, /Unauthorized|Administrator access is required/);
  }

  const createResponse = await invokeRoute(app, {
    method: 'post',
    routePath: '/api/admin/submissions',
    cookie: adminLogin.cookie,
    body: {
      company: 'Delete Test Company',
      seller_name: 'Delete Test Seller',
      seller_email: 'delete-test@example.com',
      message: 'Manual CRM record created for delete route coverage.',
      lead_type: 'seller',
    },
  });

  assert.equal(createResponse.statusCode, 201);
  assert.equal(createResponse.body.success, true);
  assert.ok(createResponse.body.submission.id);

  const deleteResponse = await invokeRoute(app, {
    method: 'delete',
    routePath: '/api/admin/submissions/:id',
    cookie: adminLogin.cookie,
    params: { id: createResponse.body.submission.id },
  });

  assert.equal(deleteResponse.statusCode, 200);
  assert.equal(deleteResponse.body.success, true);
  assert.equal(deleteResponse.body.submission.id, createResponse.body.submission.id);

  const listResponse = await invokeRoute(app, {
    method: 'get',
    routePath: '/api/admin/submissions',
    cookie: adminLogin.cookie,
  });

  assert.equal(listResponse.statusCode, 200);
  assert.equal(
    listResponse.body.submissions.some((submission) => submission.id === createResponse.body.submission.id),
    false,
  );

  const secondViewerLogin = await loginAdmin('viewer-test', 'viewer-password', request);
  const revokeAllResponse = await invokeRoute(app, {
    method: 'post',
    routePath: '/api/admin/sessions/revoke-all',
    cookie: viewerCookie,
  });
  assert.equal(revokeAllResponse.statusCode, 200);
  assert.ok(revokeAllResponse.body.revoked >= 2);
  assert.equal(await requireAdminAccess({ headers: { cookie: viewerCookie } }), null);
  assert.equal(await requireAdminAccess({ headers: { cookie: secondViewerLogin.cookie } }), null);
  assert.equal((await requireAdminAccess({ headers: { cookie: firstMagicVerification.cookie } }))?.username, 'viewer@example.com');

  const revokeAllAdminResponse = await invokeRoute(app, {
    method: 'post',
    routePath: '/api/admin/sessions/revoke-all',
    cookie: adminMagicVerification.cookie,
  });
  assert.equal(revokeAllAdminResponse.statusCode, 200);
  assert.ok(revokeAllAdminResponse.body.revoked >= 4);
  assert.equal(await requireAdminAccess({ headers: { cookie: adminLogin.cookie } }), null);
  assert.equal(await requireAdminAccess({ headers: { cookie: adminMagicVerification.cookie } }), null);
  assert.equal((await requireAdminAccess({ headers: { cookie: firstMagicVerification.cookie } }))?.role, 'viewer');

  const logoutResponse = await invokeRoute(app, {
    method: 'delete',
    routePath: '/api/admin/session',
    cookie: adminLogin.cookie,
  });
  assert.equal(logoutResponse.statusCode, 200);
  assert.match(logoutResponse.headers['set-cookie'], /Max-Age=0/);
  assert.equal(await requireAdminAccess({ headers: { cookie: adminLogin.cookie } }), null);
});
