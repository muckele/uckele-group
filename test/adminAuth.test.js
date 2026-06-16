import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  process.env.SQLITE_PATH = path.join(tempDir, 'auth.sqlite');

  const {
    getAdminAuthState,
    loginAdmin,
    requestAdminMagicLink,
    requireAdmin,
    requireAdminAccess,
  } = await import('../server/services/auth.js');
  const { signPayload } = await import('../server/utils/security.js');
  const { createApp } = await import('../server/app.js');
  const request = { headers: {}, ip: '127.0.0.1' };

  const adminLogin = await loginAdmin('admin-test', 'admin-password', request);
  assert.equal(adminLogin.ok, true);
  assert.equal(adminLogin.session.role, 'admin');
  assert.equal(requireAdmin({ headers: { cookie: adminLogin.cookie } })?.role, 'admin');
  assert.equal(requireAdminAccess({ headers: { cookie: adminLogin.cookie } })?.role, 'admin');

  const viewerLogin = await loginAdmin('viewer-test', 'viewer-password', request);
  assert.equal(viewerLogin.ok, true);
  assert.equal(viewerLogin.session.role, 'viewer');
  assert.equal(requireAdmin({ headers: { cookie: viewerLogin.cookie } }), null);
  assert.equal(requireAdminAccess({ headers: { cookie: viewerLogin.cookie } })?.role, 'viewer');

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

  const blockedRoutes = [
    { method: 'post', routePath: '/api/admin/acquisition-command-center/:id', params: { id: 'submission-1' }, body: { pipelineStage: 'passed' } },
    { method: 'post', routePath: '/api/admin/submissions', body: { name: 'Viewer Attempt' } },
    { method: 'get', routePath: '/api/admin/submissions/export' },
    { method: 'post', routePath: '/api/admin/deal-hunter/send' },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-request', body: { dealKey: 'deal-1' } },
    { method: 'post', routePath: '/api/admin/deal-hunter/cim-follow-ups/run' },
    { method: 'post', routePath: '/api/admin/prospect-discovery/run', body: { query: 'plumbers near New York NY' } },
    { method: 'patch', routePath: '/api/admin/submissions/:id', params: { id: 'submission-1' }, body: { status: 'review' } },
    { method: 'post', routePath: '/api/admin/submissions/:id/upload-request', params: { id: 'submission-1' } },
  ];

  for (const route of blockedRoutes) {
    const response = await invokeRoute(app, {
      ...route,
      cookie: viewerCookie,
    });

    assert.equal(response.statusCode, 401, `${route.method.toUpperCase()} ${route.routePath} should reject viewer access`);
    assert.equal(response.body.error, 'Unauthorized.');
  }
});
