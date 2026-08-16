import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The static file handler is only mounted in production, and config reads
// NODE_ENV once at import time, so production has to be selected before the app
// module is loaded.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-static-cache-'));
process.env.NODE_ENV = 'production';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'static-asset-cache-test-password';
process.env.ADMIN_SESSION_SECRET = 'static-asset-cache-test-session-secret';
process.env.SECURE_DOCUMENTS_TOKEN_SECRET = 'static-asset-cache-test-document-secret';
process.env.ADMIN_EMAIL = 'owner@example.test';
process.env.SQLITE_PATH = path.join(tempDir, 'static-cache.sqlite');
process.env.SECURE_DOCUMENTS_STORAGE_DIR = path.join(tempDir, 'secure-documents');

const { createApp, entryDocumentCacheControl, immutableAssetCacheControl } = await import('../server/app.js');

const distDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const probeAsset = path.join(distDirectory, 'assets', 'cache-policy-probe-Ab12Cd34.js');
const probeDownload = path.join(distDirectory, 'downloads', 'cache-policy-probe.txt');
const indexDocument = path.join(distDirectory, 'index.html');

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

test('fingerprinted assets cache immutably while entry documents revalidate', async (t) => {
  const createdIndex = !fs.existsSync(indexDocument);
  fs.mkdirSync(path.dirname(probeAsset), { recursive: true });
  fs.mkdirSync(path.dirname(probeDownload), { recursive: true });
  fs.writeFileSync(probeAsset, 'export const probe = 1;\n');
  fs.writeFileSync(probeDownload, 'probe\n');
  if (createdIndex) fs.writeFileSync(indexDocument, '<!doctype html><title>probe</title>\n');
  t.after(() => {
    fs.rmSync(probeAsset, { force: true });
    fs.rmSync(probeDownload, { force: true });
    if (createdIndex) fs.rmSync(indexDocument, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await withServer(async (origin) => {
    const asset = await fetch(`${origin}/assets/cache-policy-probe-Ab12Cd34.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), immutableAssetCacheControl);
    assert.match(asset.headers.get('cache-control'), /immutable/);

    // The SPA shell is not fingerprinted, so it must never be served immutably.
    const document = await fetch(`${origin}/`);
    assert.equal(document.status, 200);
    assert.equal(document.headers.get('cache-control'), entryDocumentCacheControl);
    assert.doesNotMatch(document.headers.get('cache-control'), /immutable/);

    // Client-routed paths fall through to the same shell and inherit its policy.
    const clientRoute = await fetch(`${origin}/admin/deal-hunter`);
    assert.equal(clientRoute.status, 200);
    assert.equal(clientRoute.headers.get('cache-control'), entryDocumentCacheControl);

    // Unfingerprinted files keep serve-static's revalidating default rather than
    // being pinned for a year alongside the hashed bundles.
    const download = await fetch(`${origin}/downloads/cache-policy-probe.txt`);
    assert.equal(download.status, 200);
    assert.doesNotMatch(download.headers.get('cache-control') || '', /immutable/);

    // The app must not compress itself; the Fly proxy only compresses responses
    // that arrive without a Content-Encoding header.
    assert.equal(asset.headers.get('content-encoding'), null);
    assert.equal(document.headers.get('content-encoding'), null);
  });
});

test('admin API responses keep their no-store policy', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/admin/session`);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
  });
});
