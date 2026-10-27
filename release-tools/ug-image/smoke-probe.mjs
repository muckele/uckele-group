// Executed only inside the capped, network-none fixture container after startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const nativePath = require.resolve('better-sqlite3/build/Release/better_sqlite3.node');
assert.ok(fs.statSync(nativePath).size <= 32 * 1024 * 1024);
const nativeSHA256 = createHash('sha256').update(fs.readFileSync(nativePath)).digest('hex');
const nativePackage = require('better-sqlite3/package.json').version;
const release = fs.readFileSync('/etc/os-release', 'utf8');
assert.match(release, /^ID=debian$/m);
assert.match(release, /^VERSION_CODENAME=bookworm$/m);

assert.equal(os.platform(), 'linux');
assert.equal(os.arch(), 'x64');
assert.match(process.versions.node, /^22\./);
const memory = new Database(':memory:');
assert.equal(memory.prepare('SELECT 41 + 1 AS answer').get().answer, 42);
const sqliteVersion = memory.prepare('SELECT sqlite_version() AS version').get().version;
memory.close();
const database = new Database('/tmp/ug-smoke/fixture.sqlite', { readonly: true, fileMustExist: true });
const counts = {};
for (const name of ['admin_magic_links', 'admin_sessions', 'secure_document_cleanup_jobs', 'crm_communications']) {
  counts[name] = database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count;
  assert.equal(counts[name], 0, `unexpected synthetic maintenance work: ${name}`);
}
database.close();
const results = [];
async function get(path, maximum, type) {
  assert.match(path, /^\/(?:api\/ready|$|assets\/[A-Za-z0-9_.-]+)$/);
  const response = await fetch(`http://127.0.0.1:8787${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('content-type') || '', type);
  const parts = []; let bytes = 0;
  for await (const part of response.body) {
    bytes += part.byteLength;
    assert.ok(bytes <= maximum, `response cap: ${path}`);
    parts.push(part);
  }
  assert.ok(bytes > 0);
  const body = Buffer.concat(parts);
  results.push({ path, status: response.status, bytes,
    sha256: createHash('sha256').update(body).digest('hex') });
  return body.toString('utf8');
}
assert.equal(JSON.parse(await get('/api/ready', 65536, /json/)).ok, true);
assert.equal(fs.statSync('/tmp/ug-smoke/documents').isDirectory(), true);
const html = await get('/', 512 * 1024, /html/);
const js = html.match(/<script\b[^>]*\bsrc=["'](\/assets\/[A-Za-z0-9_.-]+\.js)["']/i)?.[1];
const css = html.match(/<link\b[^>]*\bhref=["'](\/assets\/[A-Za-z0-9_.-]+\.css)["']/i)?.[1];
assert.ok(js && css, 'packaged JS/CSS references missing');
await get(js, 4 * 1024 * 1024, /javascript/);
await get(css, 1024 * 1024, /css/);
assert.equal(results.length, 4);
console.log(JSON.stringify({ node: process.versions.node, platform: os.platform(),
  architecture: os.arch(), nodeModuleABI: process.versions.modules, nativePackage,
  nativeSHA256, sqliteVersion, nativeSqliteQuery: true, emptyFixtureCounts: counts,
  GETs: results, timers: 'unchanged registration/startup; periodic callbacks untested' }));
