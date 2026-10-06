import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

const defaultMaximumEntries = 10_000;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const databaseName = 'cim-replay.sqlite3';
const applicationId = 0x43494d52;
const schemaVersion = 1;
const maximumResultBytes = 64 * 1024;

function currentTime(now) {
  const value = now();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Replay store clock is invalid.');
  return parsed;
}

function validateRoot(root) {
  const value = String(root || '').trim();
  if (!path.isAbsolute(value) || path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new Error('Replay store root must be an explicit bounded absolute path.');
  }
  return path.resolve(value);
}

function validateIdentity({ keyId, requestId, requestDigest, expiresAt }) {
  if (!identityPattern.test(String(keyId || '')) || !identityPattern.test(String(requestId || ''))) {
    throw new Error('Replay identity is invalid.');
  }
  if (!digestPattern.test(String(requestDigest || ''))) throw new Error('Replay digest is invalid.');
  const expiry = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(expiry)) throw new Error('Replay expiry is invalid.');
  return expiry;
}

function assertActive({ deadlineAt, signal } = {}) {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= performance.now()) {
    const error = new Error('Replay store deadline is invalid or expired.');
    error.code = 'CIM_SCAN_DEADLINE';
    throw error;
  }
  if (!signal || typeof signal.aborted !== 'boolean') {
    throw new Error('Replay store abort signal is required.');
  }
  if (signal.aborted) {
    const suffix = signal.reason instanceof Error && signal.reason.message
      ? `: ${signal.reason.message}` : '';
    const error = new Error(`Replay store operation was aborted${suffix}.`);
    error.code = 'CIM_SCAN_ABORTED';
    throw error;
  }
}

async function ensureRoot(root) {
  try {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Replay store root must be a private real directory.');
  }
}

async function ensurePrivateDatabaseFile(file, input) {
  assertActive(input);
  let handle;
  try {
    handle = await fsp.open(file, 'wx', 0o600);
    await handle.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await handle?.close();
  }
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Existing replay store database must be a private real file.');
  }
}

function validateDatabaseIdentity(database) {
  const existingApplicationId = database.pragma('application_id', { simple: true });
  const existingVersion = database.pragma('user_version', { simple: true });
  if (existingApplicationId !== 0 && existingApplicationId !== applicationId) {
    throw new Error('Replay store database belongs to another application.');
  }
  if (existingVersion !== 0 && existingVersion !== schemaVersion) {
    throw new Error('Replay store database schema version is unsupported.');
  }
  return { existingApplicationId, existingVersion };
}

function isBusy(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}

function waitForRetry(input) {
  assertActive(input);
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function initializeDatabase(file, input) {
  for (;;) {
    assertActive(input);
    const database = new Database(file, { timeout: 0 });
    let transactionOpen = false;
    try {
      database.pragma('busy_timeout = 0');
      database.pragma('synchronous = FULL');
      const quickCheck = database.pragma('quick_check', { simple: true });
      if (quickCheck !== 'ok') throw new Error('Replay store database failed its integrity check.');
      let identity = validateDatabaseIdentity(database);
      if (identity.existingApplicationId === applicationId
        && identity.existingVersion === schemaVersion) return database;
      database.exec('BEGIN EXCLUSIVE');
      transactionOpen = true;
      identity = validateDatabaseIdentity(database);
      if (identity.existingApplicationId === 0 && identity.existingVersion === 0) {
        const tables = database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `).all();
        if (tables.length > 0) throw new Error('Replay store database contains unknown state.');
        database.exec(`
          CREATE TABLE replay_entries (
            key_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            result_expires_at INTEGER,
            result_wire TEXT,
            PRIMARY KEY (key_id, request_id),
            CHECK ((result_expires_at IS NULL) = (result_wire IS NULL))
          ) WITHOUT ROWID;
          PRAGMA application_id = ${applicationId};
          PRAGMA user_version = ${schemaVersion};
        `);
      } else if (identity.existingApplicationId !== applicationId
        || identity.existingVersion !== schemaVersion) {
        throw new Error('Replay store database initialization is inconsistent.');
      }
      assertActive(input);
      database.exec('COMMIT');
      transactionOpen = false;
      assertActive(input);
      return database;
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK'); } catch { /* preserve the authoritative failure */ }
      }
      database.close();
      if (!isBusy(error)) throw error;
      await waitForRetry(input);
    }
  }
}

async function immediateTransaction(database, input, operation) {
  for (;;) {
    assertActive(input);
    let transactionOpen = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const result = operation();
      assertActive(input);
      database.exec('COMMIT');
      transactionOpen = false;
      // Once COMMIT returns, its result is authoritative.  A post-commit
      // deadline assertion could report a timeout after durable publication.
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { database.exec('ROLLBACK'); } catch { /* preserve the authoritative failure */ }
      }
      if (!isBusy(error)) throw error;
      await waitForRetry(input);
    }
  }
}

async function verifyInitializedDatabase(database, input) {
  for (;;) {
    assertActive(input);
    try {
      database.prepare('SELECT key_id FROM replay_entries LIMIT 1').get();
      return database;
    } catch (error) {
      if (isBusy(error)) {
        await waitForRetry(input);
        continue;
      }
      database.close();
      throw new Error('Replay store database schema is invalid.', { cause: error });
    }
  }
}

function validateStoredEntry(entry) {
  if (!entry || !identityPattern.test(entry.key_id) || !identityPattern.test(entry.request_id)
    || !digestPattern.test(entry.request_digest) || !Number.isSafeInteger(entry.expires_at)
    || (entry.result_expires_at !== null && !Number.isSafeInteger(entry.result_expires_at))
    || (entry.result_wire !== null && (typeof entry.result_wire !== 'string'
      || Buffer.byteLength(entry.result_wire, 'utf8') > maximumResultBytes))) {
    throw new Error('Replay store database contains an invalid entry.');
  }
  if ((entry.result_expires_at === null) !== (entry.result_wire === null)) {
    throw new Error('Replay store database contains inconsistent result authority.');
  }
  if (entry.result_wire !== null) {
    let result;
    try { result = JSON.parse(entry.result_wire); } catch {
      throw new Error('Replay store database contains a malformed result.');
    }
    if (result?.keyId !== entry.key_id || result?.requestId !== entry.request_id
      || result?.requestDigest !== entry.request_digest
      || Date.parse(result?.expiresAt || '') !== entry.result_expires_at
      || entry.result_expires_at > entry.expires_at) {
      throw new Error('Replay store database contains mismatched result authority.');
    }
  }
  return entry;
}

export function createFilesystemCimReplayStore({
  root,
  maxEntries = defaultMaximumEntries,
  now = () => new Date(),
} = {}) {
  const replayRoot = validateRoot(root);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > defaultMaximumEntries) {
    throw new Error('Replay store maximum entries is invalid.');
  }
  if (typeof now !== 'function') throw new Error('Replay store clock must be a function.');
  let databasePromise;
  let queue = Promise.resolve();
  const serialized = (operation) => {
    const running = queue.then(operation, operation);
    queue = running.catch(() => {});
    return running;
  };
  const openDatabase = async (input) => {
    assertActive(input);
    if (!databasePromise) {
      databasePromise = (async () => {
        await ensureRoot(replayRoot);
        const file = path.join(replayRoot, databaseName);
        await ensurePrivateDatabaseFile(file, input);
        const database = await verifyInitializedDatabase(
          await initializeDatabase(file, input), input,
        );
        const stat = await fsp.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
          database.close();
          throw new Error('Replay store database must be a private real file.');
        }
        return database;
      })().catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    const database = await databasePromise;
    assertActive(input);
    return database;
  };

  return Object.freeze({
    async claim(input = {}) {
      return serialized(async () => {
        const requestExpiry = validateIdentity(input);
        const database = await openDatabase(input);
        const at = currentTime(now);
        return immediateTransaction(database, input, () => {
          assertActive(input);
          database.prepare('DELETE FROM replay_entries WHERE expires_at <= ?').run(at);
          assertActive(input);
          const existing = database.prepare(`
            SELECT key_id, request_id, request_digest, expires_at,
                   result_expires_at, result_wire
            FROM replay_entries WHERE key_id = ? AND request_id = ?
          `).get(input.keyId, input.requestId);
          if (existing) {
            validateStoredEntry(existing);
            if (existing.expires_at <= at) {
              throw new Error('Replay store retained an expired entry.');
            }
            if (existing.request_digest !== input.requestDigest) return { status: 'conflict' };
            if (existing.result_wire !== null && existing.result_expires_at > at) {
              return { status: 'replay', resultWire: existing.result_wire };
            }
            return { status: 'inflight' };
          }
          if (requestExpiry <= at) return { status: 'capacity' };
          const count = database.prepare('SELECT COUNT(*) AS count FROM replay_entries').get().count;
          if (!Number.isSafeInteger(count) || count >= maxEntries) return { status: 'capacity' };
          assertActive(input);
          database.prepare(`
            INSERT INTO replay_entries (key_id, request_id, request_digest, expires_at)
            VALUES (?, ?, ?, ?)
          `).run(input.keyId, input.requestId, input.requestDigest, requestExpiry);
          assertActive(input);
          return { status: 'accepted' };
        });
      });
    },

    async complete(input = {}) {
      return serialized(async () => {
        validateIdentity({ ...input, expiresAt: new Date(currentTime(now) + 1).toISOString() });
        const database = await openDatabase(input);
        const at = currentTime(now);
        return immediateTransaction(database, input, () => {
          assertActive(input);
          database.prepare('DELETE FROM replay_entries WHERE expires_at <= ?').run(at);
          const claim = database.prepare(`
            SELECT key_id, request_id, request_digest, expires_at,
                   result_expires_at, result_wire
            FROM replay_entries WHERE key_id = ? AND request_id = ?
          `).get(input.keyId, input.requestId);
          if (!claim) return false;
          validateStoredEntry(claim);
          if (claim.request_digest !== input.requestDigest || claim.result_wire !== null) return false;
          let result;
          if (typeof input.resultWire !== 'string'
            || Buffer.byteLength(input.resultWire, 'utf8') > maximumResultBytes) return false;
          try { result = JSON.parse(input.resultWire); } catch { return false; }
          const resultExpiresAt = Date.parse(result?.expiresAt || '');
          if (result?.keyId !== input.keyId || result?.requestId !== input.requestId
            || result?.requestDigest !== input.requestDigest
            || !Number.isFinite(resultExpiresAt) || resultExpiresAt <= at
            || resultExpiresAt > claim.expires_at) return false;
          assertActive(input);
          const update = database.prepare(`
            UPDATE replay_entries
            SET result_expires_at = ?, result_wire = ?
            WHERE key_id = ? AND request_id = ?
              AND request_digest = ? AND result_wire IS NULL
          `).run(resultExpiresAt, input.resultWire, input.keyId, input.requestId, input.requestDigest);
          assertActive(input);
          return update.changes === 1;
        });
      });
    },
  });
}
