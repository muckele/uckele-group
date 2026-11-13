import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fillerRowBytes = 4000;
// better-sqlite3 builds SQLite with a 16 MB default page cache per connection, so the online-backup
// copy (a source and a destination connection) adds a fixed ~45 MB of RSS whatever the database
// size. The bound allows that fixed cost plus half the database, while the old in-memory
// inspection, which held 4-5 copies of the database, exceeds it several times over.
const targetDatabaseBytes = 96 * 1024 * 1024;
const fixedGrowthAllowanceBytes = 32 * 1024 * 1024;

function testConfig(root) {
  return {
    storage: { provider: 'sqlite', sqlitePath: path.join(root, 'source.sqlite') },
    secureDocuments: { storageDir: path.join(root, 'secure-documents') },
    protection: { rateLimitRetentionMs: 0 },
    backup: {
      enabled: true,
      directory: path.join(root, 'backups'),
      retentionDays: 30,
      retentionCount: 2,
      time: '03:30',
      timezone: 'America/Los_Angeles',
      checkIntervalMs: 900000,
    },
  };
}

// Runs in a fresh child process so its peak RSS reflects only this one backup.
const childScript = `
const [storageUrl, backupsUrl, configJson] = process.argv.slice(1);
const { createSqliteStorage } = await import(storageUrl);
const { createBackupBundle } = await import(backupsUrl);
const config = JSON.parse(configJson);
const storage = createSqliteStorage(config);
const fs = await import('node:fs');
const dbBytes = fs.statSync(config.storage.sqlitePath).size;
const baselineKb = process.resourceUsage().maxRSS;
await createBackupBundle({ storage, config, now: new Date('2026-11-13T11:30:00.000Z') });
const peakKb = process.resourceUsage().maxRSS;
storage.close();
process.stdout.write(JSON.stringify({ baselineKb, peakKb, dbBytes }));
`;

test('a backup of a large database does not hold the database in memory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-backup-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = testConfig(root);
  createSqliteStorage(config).close();

  const filler = new Database(config.storage.sqlitePath);
  try {
    filler.exec('CREATE TABLE IF NOT EXISTS backup_memory_filler (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');
    const rows = Math.ceil(targetDatabaseBytes / fillerRowBytes);
    filler.prepare(`
      WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ?)
      INSERT INTO backup_memory_filler (payload) SELECT randomblob(?) FROM counter
    `).run(rows, fillerRowBytes);
    filler.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    filler.close();
  }
  assert.ok(fs.statSync(config.storage.sqlitePath).size >= 90 * 1024 * 1024, 'the source database must be at least 90 MB');

  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    childScript,
    pathToFileURL(path.join(repositoryRoot, 'server/storage/sqlite.js')).href,
    pathToFileURL(path.join(repositoryRoot, 'server/services/backups.js')).href,
    JSON.stringify(config),
  ], { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, `backup child failed: ${child.stderr}`);
  const { baselineKb, peakKb, dbBytes } = JSON.parse(child.stdout);
  const growthBytes = (peakKb - baselineKb) * 1024;
  t.diagnostic(`database ${dbBytes} bytes; RSS baseline ${baselineKb} KB, peak ${peakKb} KB, growth ${growthBytes} bytes (${(growthBytes / dbBytes).toFixed(2)}x)`);

  assert.ok(
    growthBytes < dbBytes * 0.5 + fixedGrowthAllowanceBytes,
    `backup grew RSS by ${growthBytes} bytes for a ${dbBytes}-byte database (${(growthBytes / dbBytes).toFixed(2)}x)`,
  );
  assert.equal(fs.readdirSync(config.backup.directory).filter((name) => name.startsWith('backup-')).length, 1);
});
