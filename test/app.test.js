import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_SESSION_SECRET = 'app-test-session-secret';
process.env.SECURE_DOCUMENTS_MAX_UPLOAD_BYTES = '1024';
process.env.TURNSTILE_SITE_KEY = 'public-turnstile-test-key';

const { createApp, handleAppError } = await import('../server/app.js');
const { getSecureUploadJsonLimitBytes } = await import('../server/services/documentVault.js');

function routeLayer(app, method, routePath) {
  return app._router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method]);
}

async function invokeRoute(app, { method, routePath }) {
  const layer = routeLayer(app, method, routePath);

  assert.ok(layer, `${method.toUpperCase()} ${routePath} route should exist`);

  const request = {
    body: {},
    headers: {
      host: 'localhost',
    },
    ip: '127.0.0.1',
    method: method.toUpperCase(),
    params: {},
    query: {},
    socket: {},
  };
  const response = createResponse();
  let routeError = null;

  await layer.route.stack.at(-1).handle(request, response, (error) => {
    routeError = error;
  });

  if (routeError) {
    throw routeError;
  }

  return response;
}

function createResponse() {
  return {
    body: undefined,
    headers: {},
    headersSent: false,
    statusCode: 200,
    json(payload) {
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
}

test('public health check only exposes availability', async () => {
  const response = await invokeRoute(createApp(), {
    method: 'get',
    routePath: '/api/health',
  });

  assert.deepEqual(response.body, { ok: true });
});

test('public config only exposes browser-safe settings', async () => {
  const response = await invokeRoute(createApp(), {
    method: 'get',
    routePath: '/api/public-config',
  });

  assert.deepEqual(response.body, {
    success: true,
    turnstileSiteKey: 'public-turnstile-test-key',
    turnstileEnabled: false,
  });
});

test('app error handler preserves parser client error statuses', () => {
  const badJsonResponse = createResponse();
  const tooLargeResponse = createResponse();
  const originalConsoleWarn = console.warn;

  try {
    console.warn = () => {};
    handleAppError({ expose: true, status: 400, message: 'bad json' }, {}, badJsonResponse, () => {});
    handleAppError({ expose: true, status: 413, message: 'payload too large' }, {}, tooLargeResponse, () => {});
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(badJsonResponse.statusCode, 400);
  assert.deepEqual(badJsonResponse.body, {
    success: false,
    error: 'Invalid request body.',
  });
  assert.equal(tooLargeResponse.statusCode, 413);
  assert.deepEqual(tooLargeResponse.body, {
    success: false,
    error: 'Request body is too large.',
  });
});

test('secure upload JSON parser limit accounts for base64 batch overhead', () => {
  assert.ok(getSecureUploadJsonLimitBytes() > 1024 * 5);
});
