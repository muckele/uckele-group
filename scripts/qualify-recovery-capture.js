// Synthetic-only qualification runner. No application config, live path, or network input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import Database from 'better-sqlite3';
import { createZeroDocumentRecoveryBundle, recoveryCaptureLimits } from '../server/services/recoveryCapture.js';

const MiB = 1024 * 1024;
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function worker(root, mib, hang) {
  const source = path.join(root, 'source.sqlite');
  const reservation = await fs.open(source, 'wx', 0o600);
  await reservation.close();
  const database = new Database(source);
  try {
    database.pragma('cache_size = -2048');
    database.pragma('journal_mode = WAL');
    database.exec('CREATE TABLE payload(value BLOB); CREATE TABLE records(value TEXT);');
    const pageSize = database.pragma('page_size', { simple: true });
    const insert = database.prepare('INSERT INTO payload VALUES (zeroblob(262144))');
    while (database.pragma('page_count', { simple: true }) * pageSize < mib * MiB - MiB / 2) insert.run();
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.pragma('wal_autocheckpoint = 0');
    database.exec("INSERT INTO records VALUES ('WAL-only committed row')");
    const before = await Promise.all([hash(source), hash(`${source}-wal`)]);
    const output = path.join(root, 'output');
    await fs.mkdir(output, { mode: 0o700 });
    process.send({ phase: 'capture', rss: process.memoryUsage.rss() });
    if (hang) {
      process.on('SIGTERM', () => {}); // Force proof of the supervisor's SIGKILL escalation.
      for (;;) { /* Parent must terminate blocked native-like work. */ }
    }
    const result = await createZeroDocumentRecoveryBundle({ database, parentDirectory: output });
    const copy = new Database(path.join(result.path, 'database.sqlite'), { readonly: true, fileMustExist: true });
    try {
      if (copy.prepare('SELECT value FROM records').get()?.value !== 'WAL-only committed row') throw new Error('WAL state missing.');
    } finally { copy.close(); }
    const after = await Promise.all([hash(source), hash(`${source}-wal`)]);
    if (before.some((digest, index) => digest !== after[index])) throw new Error('Source changed.');
    if (await hash(path.join(result.path, 'database.sqlite')) !== result.manifest.database.sha256) throw new Error('Published hash mismatch.');
    if ((await fs.readdir(result.path)).sort().join(',') !== 'database.sqlite,manifest.json') throw new Error('Unexpected published sidecars.');
    process.send({ phase: 'result', ok: true, platform: process.platform, node: process.version,
      sqlite: database.prepare('SELECT sqlite_version() AS version').get().version,
      databaseBytes: result.manifest.database.sizeBytes, rss: process.memoryUsage.rss(),
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      sourceHashesUnchanged: true, walOnlyRowCaptured: true, publishedHashVerified: true });
  } finally { database.close(); }
}

async function removeOwnedFixture(root, identity) {
  const current = await fs.lstat(root, { bigint: true });
  if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || await fs.realpath(root) !== root) throw new Error('Synthetic fixture identity changed; cleanup refused.');
  await fs.rm(root, { recursive: true }); // Freshly owned synthetic-only root, never caller input.
}

async function supervise(mib, hang) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ug-recovery-qualification-')));
  const identity = await fs.lstat(root, { bigint: true });
  let child;
  let peakSampledRssBytes = 0;
  let stopReason = null;
  let result = null;
  let totalDeadline;
  let captureDeadline;
  let forceKill;
  let monitor;
  let reading = false;
  let spawnError;
  try {
    child = fork(fileURLToPath(import.meta.url), ['--worker', root, String(mib), hang ? 'hang' : 'normal'], {
      execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      // Do not forward application credentials/configuration to the synthetic worker.
      env: { PATH: path.dirname(process.execPath), TMPDIR: os.tmpdir(), NODE_ENV: 'test' },
    });
    let diagnostic = '';
    child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
    const exited = new Promise((resolve) => {
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    function stop(reason) {
      if (stopReason) return;
      stopReason = reason;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
    }
    totalDeadline = setTimeout(() => stop('total-timeout'), 90_000);
    child.on('message', (message) => {
      peakSampledRssBytes = Math.max(peakSampledRssBytes, message.rss || 0);
      if (message.phase === 'capture') {
        clearTimeout(captureDeadline);
        captureDeadline = setTimeout(() => stop('capture-timeout'), hang ? 100 : 45_000);
      }
      if (message.phase === 'result') result = message;
    });
    if (process.platform === 'linux') monitor = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const status = await fs.readFile(`/proc/${child.pid}/status`, 'utf8');
        const rss = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] || 0) * 1024;
        peakSampledRssBytes = Math.max(peakSampledRssBytes, rss);
        if (rss > recoveryCaptureLimits.maxRssBytes) stop('rss-limit');
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') stop('rss-monitor-error'); }
      finally { reading = false; }
    }, 25);
    const exit = await exited; // No cleanup before the worker has positively exited.
    clearTimeout(totalDeadline); clearTimeout(captureDeadline); clearTimeout(forceKill); clearInterval(monitor);
    if (spawnError) throw spawnError;
    if (hang) {
      if (stopReason !== 'capture-timeout' || exit.signal !== 'SIGKILL') throw new Error('Timeout arbitration did not terminate worker.');
      result = { ok: true, expectedTimeout: true, terminationSignal: exit.signal, childExitConfirmed: true };
    } else if (stopReason || exit.code !== 0 || !result?.ok) throw new Error(`Qualification failed: ${stopReason || diagnostic || JSON.stringify(exit)}`);
    const peak = Math.max(peakSampledRssBytes, result.processPeakRssBytes || 0);
    if (peak > recoveryCaptureLimits.maxRssBytes) throw new Error(`Peak RSS exceeds guard: ${peak}`);
    return { ...result, peakRssBytes: peak, linuxProcMonitor: process.platform === 'linux', childExitConfirmed: true };
  } finally {
    clearTimeout(totalDeadline); clearTimeout(captureDeadline); clearTimeout(forceKill); clearInterval(monitor);
    await removeOwnedFixture(root, identity);
  }
}

if (process.argv[2] === '--worker') {
  if (!process.send) throw new Error('Worker requires supervisor IPC.');
  await worker(process.argv[3], Number(process.argv[4]), process.argv[5] === 'hang');
} else {
  const args = process.argv.slice(2);
  const hang = args.length === 1 && args[0] === '--test-timeout';
  const mib = hang ? 1 : args.length === 0 ? 4 : args.length === 2 && args[0] === '--database-mib' ? Number(args[1]) : NaN;
  if (!Number.isInteger(mib) || mib < 1 || mib > 154) throw new Error('Usage: --database-mib 1..154 or --test-timeout; synthetic data only.');
  console.log(JSON.stringify({ ...await supervise(mib, hang), syntheticFixtureCleanupConfirmed: true }));
}
