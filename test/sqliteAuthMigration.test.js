import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSqliteStorage } from '../server/storage/sqlite.js';

test('SQLite replaces the legacy magic-link table without losing its audit copy', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uckele-auth-migration-'));
  const sqlitePath = path.join(directory, 'auth.sqlite');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const legacy = new Database(sqlitePath);
  legacy.exec(`
    CREATE TABLE admin_magic_links (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX idx_admin_magic_links_expires_at ON admin_magic_links(expires_at);
    INSERT INTO admin_magic_links (id, email, created_at, expires_at, used_at)
    VALUES ('legacy-link', 'admin@example.com', '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z', NULL);
  `);
  legacy.close();

  const storage = createSqliteStorage({ storage: { sqlitePath } });
  await storage.insertAdminMagicLink({
    token_hash: 'new-token-hash',
    created_at: '2026-07-15T01:00:00.000Z',
    expires_at: '2026-07-15T02:00:00.000Z',
    email: 'admin@example.com',
    role: 'admin',
    requested_ip_hash: 'ip-hash',
    metadata: {},
  });
  storage.close();

  const migrated = new Database(sqlitePath, { readonly: true });
  const currentColumns = migrated.prepare('PRAGMA table_info(admin_magic_links)').all().map((column) => column.name);
  const legacyRows = migrated.prepare('SELECT * FROM admin_magic_links_legacy_v1').all();
  const currentRows = migrated.prepare('SELECT * FROM admin_magic_links').all();
  const expiryIndex = migrated.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_admin_magic_links_expires_at'").get();
  migrated.close();

  assert.ok(currentColumns.includes('token_hash'));
  assert.ok(currentColumns.includes('consumed_at'));
  assert.equal(legacyRows.length, 1);
  assert.equal(legacyRows[0].id, 'legacy-link');
  assert.equal(currentRows.length, 1);
  assert.equal(currentRows[0].token_hash, 'new-token-hash');
  assert.equal(expiryIndex.tbl_name, 'admin_magic_links');
});
