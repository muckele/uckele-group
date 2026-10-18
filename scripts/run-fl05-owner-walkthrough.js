import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { fixtureEnvironment } from './fl05-fixture-environment.js';
import { stopOwnedProcessGroup } from './fl05-owned-process.js';

const cwd = fileURLToPath(new URL('..', import.meta.url));
if (!fs.existsSync(path.join(cwd, 'dist', 'index.html'))) {
  throw new Error('Run npm run build before the FL05 walkthrough.');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-fl05-owner-'));
const disk = fs.statfsSync(root);
if (disk.bavail * disk.bsize < 11 * 1024 ** 3) throw new Error('FL05 requires 11 GiB free disk space.');
for (const name of ['home', 'tmp']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
fs.writeFileSync(path.join(root, '.fl05-owned-fixture'), 'synthetic-local-only', { mode: 0o600 });
fs.writeFileSync(path.join(root, 'source-identity.json'), JSON.stringify({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim(),
  diffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd })).digest('hex'),
  builtIndexSha256: createHash('sha256').update(fs.readFileSync(path.join(cwd, 'dist', 'index.html'))).digest('hex'),
  sourceFiles: Object.fromEntries([
    'scripts/run-fl05-owner-walkthrough.js', 'scripts/fl05-fixture-environment.js', 'scripts/fl05-owned-process.js',
    'test-owner-flow/fixture.js', 'test-owner-flow/network-guard.js', 'test-owner-flow/owner-flow.test.js',
    'src/components/admin/OpportunityDrawer.jsx',
  ].map((name) => [name, createHash('sha256').update(fs.readFileSync(path.join(cwd, name))).digest('hex')])),
}, null, 2));
console.log(`FL05 evidence directory: ${root}`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'test-owner-flow/owner-flow.test.js'], {
  cwd, stdio: 'inherit', detached: true, env: fixtureEnvironment(root, chromium.executablePath()),
});
let browserPid, stopping;
const browserPidPath = path.join(root, 'owned-browser.json');
function registerBrowser() {
  if (browserPid || !fs.existsSync(browserPidPath)) return;
  const { pid } = JSON.parse(fs.readFileSync(browserPidPath, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === child.pid) throw new Error('Invalid owned browser registration');
  browserPid = pid;
  fs.writeFileSync(path.join(root, 'browser-registered'), String(pid), { flag: 'wx', mode: 0o600 });
}
const registration = setInterval(() => {
  try { registerBrowser(); } catch (error) { console.error(error.message); process.exitCode = 1; void stop(); }
}, 25);
function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(registration);
    // Playwright launches Chromium into its own process group. Register that
    // exact owned PID before the browser journey, and stop both groups.
    const results = await Promise.allSettled([
      child.pid ? stopOwnedProcessGroup(child.pid) : Promise.resolve({ absent: true }),
    ]);
    // The child is now absent (or bounded shutdown failed), so registration is
    // read once more after its last possible spawn. This contains ownership
    // published during shutdown, rather than caching an early empty PID.
    registerBrowser();
    results.push(...await Promise.allSettled([
      browserPid ? stopOwnedProcessGroup(browserPid) : Promise.resolve({ absent: true }),
    ]));
    fs.writeFileSync(path.join(root, 'process-cleanup.json'), JSON.stringify(results, null, 2));
    if (results.some((result) => result.status === 'rejected')) process.exitCode = 1;
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
  return stopping;
}
const timeout = setTimeout(() => { process.exitCode = 1; void stop(); }, 180_000);
const forward = () => { process.exitCode = 1; void stop(); };
process.once('SIGTERM', forward);
process.once('SIGINT', forward);
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; clearTimeout(timeout); void stop(); });
child.once('exit', async (code, signal) => {
  clearTimeout(timeout);
  if (signal || code !== 0) process.exitCode = 1;
  await stop();
  process.removeListener('SIGTERM', forward);
  process.removeListener('SIGINT', forward);
});
