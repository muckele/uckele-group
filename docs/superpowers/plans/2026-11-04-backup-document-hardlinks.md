# Backup Document Hardlinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily backup bundles hardlink vault documents instead of copying them, so a document costs about 1× its size on `/data` instead of about 15×, and one damaged document can never cost a database backup.

**Architecture:**
- `server/services/backups.js` gains a document-level verification result (`documentsDegraded`) and a new bundle state, `degraded`. A bundle whose database verifies is never pruned as invalid, and it still counts for normal count/age retention.
- `copySecureDocuments` tries `fs.link` first and falls back to `fs.copyFile` on any link error.
- Restore and the repair scripts keep using `verification.ok`, whose meaning does not change: everything verifies.

**Tech Stack:** Node 22 ESM, better-sqlite3, `node:fs/promises`, `node --test`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-pursued-deals-tracker-design.md` §8.2 (PR A), §10 "Backups", §11 steps 1–2.

**Branch:** `codex/backup-document-hardlinks`, from `origin/main` (`0687eb7`). It ships before `codex/pursued-deals-tracker`.

## Global Constraints

- No new npm dependencies.
- Placing a document: `fs.link(sourcePath, copiedPath)` first, and `fs.copyFile` on **any** `fs.link` error (for example `EXDEV`, `EPERM`, `ENOTSUP`, `EMLINK`).
- **A bad document must never delete database backups.** Never auto-delete a bundle whose database snapshot verifies.
- Report a document mismatch as `documentsDegraded`, not as an invalid bundle.
- A new backup whose database verifies succeeds. Its document mismatch is reported separately rather than failing the backup (`backups.js:546-549`).
- `verifyBackupBundle(...).ok` keeps its current meaning: manifest, database **and** every document verify. The repair scripts that gate on `ok` stay unchanged.
- **Restore by default** (`:784-785`) still refuses anything that isn't `ok`.
- **Restore with `acceptDegradedDocuments: true`** (CLI flag `--accept-degraded-documents`) also accepts a `degraded` bundle. It restores the verified database and every document as stored, and returns `degradedDocuments: [{ id, reason }]`. With hardlinks, one damaged document degrades every bundle, so without this option no bundle could restore the database.
- **The flag never accepts an `invalid` bundle.**
- Manifest format stays `version: 2`. No new manifest fields.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Environment:**
  - Run `. "$HOME/.nvm/nvm.sh"; nvm use 22` first.
  - Vitest (`npm run test:ui`) hangs under the Bash sandbox, so run it with the sandbox off.

## Review Focus

1. **The vault and `/data/backups` sit on different filesystems,** for example after a volume or env change. `fs.link` then fails with `EXDEV` for every document. Backups must still succeed by copying. Pinned in Task 2 (`any link error falls back to a copy`).
2. **A vault file is deleted out from under the vault,** by hand or by a bug. The backup fails exactly as it does today, because a missing source still throws. It must not record a bundle with a silently missing document. Pinned in Task 1.
3. **A damaged document whose size is unchanged** (bit rot). Old bundles become `degraded`, and none of them is pruned before its normal retention age. Pinned in Task 2.
4. **Restore is asked to use a degraded bundle.**
   - **By default** it refuses, exactly as it refuses an invalid bundle today.
   - **With `acceptDegradedDocuments`** it restores the verified database and the documents, and names each damaged document. One bad file can then never block a database recovery.
   - **An invalid bundle** is refused with or without the option.
   - Pinned in Task 1.
5. **A tampered database.** It is still `invalid` and is still pruned after 24 hours. The new rule protects only bundles whose database verifies. Pinned in Task 1.

---

### Task 1: Document mismatches degrade a bundle instead of invalidating it

**Files:**
- Modify: `server/services/backups.js`:
  - `copySecureDocuments` `:390-430`
  - `inspectBackupDirectory` `:432-470`
  - `enforceBackupRetention` `:472-496`
  - `createBackupBundle` `:498-561`
  - `verifyBackupBundle` `:563-670`
  - `getBackupStatus` `:684-758`
- Modify: `src/components/admin/OperationsCenter.jsx:304`, `scripts/backup.js:42-58`, and `restoreBackupBundle` `:778-790`
- Test: `test/backups.test.js`, `test-ui/OperationsCenter.test.jsx`

**Interfaces:**
- **Produces `verifyBackupBundle(bundlePath)`.** It returns the current fields plus:
  - `databaseVerified: boolean`. True when the only errors are document-level ones.
  - `documentsDegraded: Array<{ id: string, reason: 'size_mismatch' | 'checksum_mismatch' | 'unreadable' | 'database_size_mismatch' }>`
  - `classification`, which gains `'degraded'`: the database verifies and `documentsDegraded.length > 0`. In that case `ok` is false and `errors` still lists every message.
- **Which errors are document-level.** These, and only these, make a bundle `degraded`:
  - the per-file `stat` size and checksum checks (`:621-634`);
  - the `sizeBytes` field from `compareManifestDocumentsToDatabase` (`:359-388`).

  Every other error keeps the bundle `invalid`: a manifest error, a path resolving outside the bundle, a database snapshot failure, a row-count mismatch, or any other field mismatch.
- **Produces `createBackupBundle(...)`.** It returns `{ path, manifest, documentsDegraded }`. It throws only when `!verification.databaseVerified`. The message stays `Backup integrity verification failed: …`.
- **`copySecureDocuments`** no longer throws on a size mismatch against the row, or on a before/after stat change (`:411-413`). It records the actual size and checksum, so verification classifies the document.

  It still throws when the source is missing, and when the path resolves outside the vault (`:396`).
- **Produces bundle state `'degraded'`** in `inspectBackupDirectory`.
  - `enforceBackupRetention` never applies the 24-hour invalid prune to it: that prune stays limited to `incomplete` and `invalid` (`:479-485`).
  - Count/age retention runs over `valid` and `degraded` together, newest first.
- **Produces `getBackupStatus()`.**
  - `bundleCounts.degraded` is always present.
  - `latest` is the newest bundle that is `valid` or `degraded`.
  - When any bundle is degraded, the status is `'degraded'`. The `issueSummary` list adds `${n} with mismatched documents`, placed after `legacy` and before `invalid`.
  - The status also returns `documentsDegraded: Array<{ id, reason }>`, deduplicated by `id` and capped at 20.
- **Produces `restoreBackupBundle(bundlePath, { databasePath, documentsDirectory, overwrite, acceptDegradedDocuments = false })`.**
  - It proceeds when `ok`, or when `acceptDegradedDocuments && classification === 'degraded'`.
  - The result adds `degradedDocuments` (`[]` when the bundle was `ok`).
  - `scripts/backup.js` passes `acceptDegradedDocuments: process.argv.includes('--accept-degraded-documents')`, and the usage string lists the flag.
- **OperationsCenter.** The bundle line shows `· {degraded} with mismatched documents` only when `degraded > 0`.

- [ ] **Step 1: Write the failing backend tests in `test/backups.test.js`.** Use the existing `testConfig` and the `insertSecureDocument` seeding from the drill test (`:215-240`).

```js
test('a bundle whose stored document no longer matches its checksum is degraded, kept past 24 hours, and not restorable', async (t) => {
  // seed document-1, createBackupBundle, then overwrite the bundle's copy with same-length different bytes
  const result = await verifyBackupBundle(backup.path);
  assert.equal(result.classification, 'degraded');
  assert.equal(result.ok, false);
  assert.equal(result.databaseVerified, true);
  assert.deepEqual(result.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  const removed = await enforceBackupRetention(config, new Date(Date.now() + 48 * 3600_000));
  assert.equal(removed.includes(backup.path), false);
  assert.equal(fs.existsSync(backup.path), true);
  const status = await getBackupStatus(config);
  assert.equal(status.status, 'degraded');
  assert.equal(status.bundleCounts.degraded, 1);
  assert.match(status.message, /1 with mismatched documents/);
  assert.deepEqual(status.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  await assert.rejects(restoreBackupBundle(backup.path, { databasePath, documentsDirectory }), /Backup verification failed/);
  const restored = await restoreBackupBundle(backup.path, { databasePath, documentsDirectory, acceptDegradedDocuments: true });
  assert.deepEqual(restored.degradedDocuments, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  assert.equal(restored.restoredDocuments, 1);
  // the restored database opens and holds the seeded secure_documents row
});

test('acceptDegradedDocuments never restores an invalid bundle', async (t) => {
  // createBackupBundle, append bytes to the bundle's database.sqlite
  await assert.rejects(restoreBackupBundle(backup.path, { databasePath, documentsDirectory, acceptDegradedDocuments: true }),
    /Backup verification failed/);
});

test('a vault document whose size no longer matches its row still lets the database backup succeed', async (t) => {
  // seed document-1 with size_bytes 27, then append bytes to the vault file before createBackupBundle
  const backup = await createBackupBundle({ storage, config });
  assert.deepEqual(backup.documentsDegraded, [{ id: 'document-1', reason: 'database_size_mismatch' }]);
  assert.equal(fs.existsSync(backup.path), true);
  assert.equal((await verifyBackupBundle(backup.path)).classification, 'degraded');
});

test('a missing vault document still fails the backup', async (t) => {
  // seed document-1, unlink the vault file
  await assert.rejects(createBackupBundle({ storage, config }), /ENOENT|no such file/i);
  assert.equal((await listBackupBundles(config)).length, 0);
});

test('a degraded bundle counts toward count retention like a valid one', async (t) => {
  // retentionCount 2: degrade the oldest of three bundles; after a fourth backup only the newest two remain
});

test('a tampered database is still invalid and is pruned after 24 hours', async (t) => {
  // createBackupBundle, append bytes to the bundle's database.sqlite, set its mtime 48 hours back
  assert.equal((await verifyBackupBundle(backup.path)).classification, 'invalid');
  assert.ok((await enforceBackupRetention(config, new Date())).includes(backup.path));
});
```

  Also update one existing assertion. In `retention prunes stale incomplete and invalid bundles…` (`:541`), the expected `bundleCounts` becomes `{ valid: 1, degraded: 0, legacy: 0, invalid: 1, incomplete: 2 }`. The existing `backup verification detects secure-document tampering` test (`:271-291`) tampers with the **database** and must stay `invalid` without changes. It is the regression guard for Review Focus 5.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `node --test test/backups.test.js`
  Expected: FAIL. The new tests fail on `classification` being `'invalid'` and on `documentsDegraded` being undefined; the size-mismatch test fails with `changed while the backup was being created`.

- [ ] **Step 3: Implement the split in `server/services/backups.js` as the Interfaces block describes.**
  - Collect `documentErrors` (each with a `{ id, reason }`) separately from `errors` inside `verifyBackupBundle`.
  - `compareManifestDocumentsToDatabase` returns `{ errors, documentErrors }`. Only its `sizeBytes` comparison goes to `documentErrors`, with reason `database_size_mismatch`.

- [ ] **Step 4: Write the failing UI test in `test-ui/OperationsCenter.test.jsx`.**
  - `backup card names bundles with mismatched documents`: render with `backup: { status: 'degraded', bundleCounts: { valid: 1, degraded: 2, invalid: 0, incomplete: 0 } }`, and expect the text `Bundles: 1 valid · 2 with mismatched documents · 0 invalid · 0 incomplete`.
  - With `degraded: 0`, the text is unchanged from today.

- [ ] **Step 5: Implement the OperationsCenter line (`:304`).**

- [ ] **Step 6: Run the tests.**
  - `node --test test/backups.test.js`. Expected: PASS, all tests.
  - `npm run test:ui -- OperationsCenter`, outside the sandbox. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add server/services/backups.js scripts/backup.js test/backups.test.js src/components/admin/OperationsCenter.jsx test-ui/OperationsCenter.test.jsx
git commit -m "fix: a mismatched backup document degrades its bundle instead of deleting the database backup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Hardlink vault documents into bundles, falling back to a copy

**Files:**
- Modify: `server/services/backups.js`: `copySecureDocuments` `:390-430` and `createBackupBundle` `:498`
- Test: `test/backups.test.js`

**Interfaces:**
- Consumes: Task 1's `documentsDegraded`, `databaseVerified`, and `'degraded'` state.
- Produces `createBackupBundle({ storage, config, now, fileOps })`.
  - `fileOps` defaults to `{ link: fs.link, copyFile: fs.copyFile }` and is passed through to `copySecureDocuments`.
  - It exists only so tests can inject a failing `link`. Nothing in production passes it.
- `copySecureDocuments` places each document with `fileOps.link`. On any rejection it removes a partial destination with `fs.rm(copiedPath, { force: true })` and calls `fileOps.copyFile`.
- The existing `fs.chmod(copiedPath, 0o600)` (`:407`) stays: on a link it touches an inode that is already 0600. The stability checks stay unchanged.

- [ ] **Step 1: Write the failing tests in `test/backups.test.js`.**

```js
test('backup bundles hardlink vault documents instead of copying them', async (t) => {
  const first = await createBackupBundle({ storage, config, now: new Date('2026-07-13T12:00:00.000Z') });
  const second = await createBackupBundle({ storage, config, now: new Date('2026-07-14T12:00:00.000Z') });
  const vault = fs.statSync(sourceDocument);
  for (const backup of [first, second]) {
    assert.equal(fs.statSync(path.join(backup.path, backup.manifest.secureDocuments.files[0].relativePath)).ino, vault.ino);
  }
  assert.equal(fs.statSync(sourceDocument).nlink, 3);
  assert.equal((fs.statSync(sourceDocument).mode & 0o777), 0o600);
});

test('pruning a linked bundle keeps the vault document', async (t) => {
  // retentionCount 2, three backups on consecutive days
  assert.equal(fs.readFileSync(sourceDocument, 'utf8'), 'confidential recovery drill');
  assert.equal(fs.statSync(sourceDocument).nlink, 3);
});

test('restore from a linked bundle installs independent copies', async (t) => {
  const restore = await restoreBackupBundle(backup.path, { databasePath: restoredDatabasePath, documentsDirectory: restoredDocuments });
  assert.equal(restore.restoredDocuments, 1);
  assert.notEqual(fs.statSync(restoredFile).ino, fs.statSync(sourceDocument).ino);
  assert.equal(fs.readFileSync(restoredFile, 'utf8'), 'confidential recovery drill');
});

for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK']) {
  test(`any link error falls back to a copy (${code})`, async (t) => {
    const backup = await createBackupBundle({ storage, config, fileOps: {
      link: async () => { throw Object.assign(new Error(code), { code }); }, copyFile: fs.promises.copyFile } });
    assert.notEqual(fs.statSync(bundleDocument(backup)).ino, fs.statSync(sourceDocument).ino);
    assert.equal((await verifyBackupBundle(backup.path)).ok, true);
  });
}

test('with hardlinks, a vault document damaged in place degrades every bundle, keeps them all, and a new backup still succeeds', async (t) => {
  // two backups, then overwrite the vault file in place with same-length different bytes (fs.writeFileSync on the vault path)
  for (const backup of [first, second]) {
    const result = await verifyBackupBundle(backup.path);
    assert.equal(result.classification, 'degraded');
    assert.deepEqual(result.documentsDegraded, [{ id: 'document-1', reason: 'checksum_mismatch' }]);
  }
  const removed = await enforceBackupRetention(config, new Date(Date.now() + 48 * 3600_000));
  assert.deepEqual(removed.filter((entry) => [first.path, second.path].includes(entry)), []);
  const third = await createBackupBundle({ storage, config });
  assert.equal((await verifyBackupBundle(third.path)).databaseVerified, true);
  assert.equal((await getBackupStatus(config)).status, 'degraded');
});
```

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `node --test test/backups.test.js`
  Expected: FAIL. The inodes differ, because documents are still copied; the damage test sees `classification: 'current'`.

- [ ] **Step 3: Implement `fileOps` and link-first placement in `copySecureDocuments`.**

- [ ] **Step 4: Run the tests.**
  Run: `node --test test/backups.test.js`, then `npm test`
  Expected: PASS, with no regressions. The drill test (`:215`) passes unchanged.

- [ ] **Step 5: Commit.**

```bash
git add server/services/backups.js test/backups.test.js
git commit -m "feat: hardlink vault documents into backup bundles, copying on any link error

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Run the pre-PR checks.**
  - `npm test`: PASS.
  - `npm run test:ui`: PASS, outside the sandbox.
  - `npm run build && PLAYWRIGHT_PORT=4273 npm run test:browser`: PASS.
  - `npm run lint`: clean.

  Gated Postgres is not affected; backups are SQLite-only (`backups.js:499-501`).

  The PR body states the rollout steps (spec §11 steps 1–2):
  1. Measure `/data` first, with `df -h /data` and `du -sh /data/backups /data/secure-documents /data/uckele-group.sqlite`.
  2. Extend the volume if free space is under 1.5 GiB.
  3. After the deploy, run one backup and confirm `stat -c %h` on a vault file is greater than 1.

  Old copied bundles age out over the next 14 days.
