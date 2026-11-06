# SQLite and secure-document recovery

Phase 16 uses two complementary recovery layers:

1. The application creates an application-consistent SQLite snapshot and places every secure document referenced by that snapshot into a checksummed backup bundle under `BACKUP_DIRECTORY` (default: beside the SQLite database in `backups/`). The bundle is written privately, renamed into place only after it is complete, verified with SQLite `quick_check`, and retained by both age and count. Bundle documents are hardlinks of the live vault file on the same volume; when linking fails (for example across devices or on an unsupported filesystem) the document is copied instead.
2. Fly takes daily snapshots of the `/data` volume. `fly.toml` requests 14-day retention for newly created volumes. Fly documents a five-day default and a configurable 1–60 day retention window; existing volumes must be updated separately. See [Fly volume snapshot management](https://fly.io/docs/volumes/snapshots/).

Application backups on the same Fly volume protect against inconsistent SQLite/file copies and operator mistakes, and their database snapshots are independent files. Because bundle documents are hardlinks of the vault file, bundles do not hold independent copies of document contents: Fly volume snapshots are the only independent copy of document bytes. Fly volume snapshots protect the complete volume when the active volume is damaged or replaced. For materially stronger disaster recovery, copy verified application bundles to a separately controlled encrypted store; do not treat a single volume as an offsite backup.

## Routine verification

Check the Operations page for the most recent backup, database integrity, disk capacity, and failed backup job. From an authorized shell:

```sh
npm run backup:verify
```

Without `--bundle`, this verifies only the newest bundle; pass `--bundle` to check an older one. Verification covers the complete manifest schema, SQLite snapshot integrity, one-to-one correspondence between every secure-document manifest entry and its SQLite row, manifest row counts, and every recorded size and checksum. A document whose checksum or size no longer matches, or whose file is missing, makes the bundle `degraded` (see below). A malformed or row-mismatched manifest is never considered restorable, even when it represents a database with no secure documents. To select a bundle:

A current, fully verified application bundle uses manifest version 2 and is a self-contained SQLite snapshot: `database.sqlite`, `manifest.json`, and any manifest-listed secure documents. Its persisted `database.sqlite` must contain SQLite rollback-format header bytes `1/1` at offsets 18 and 19. SQLite `database.sqlite-wal`, `database.sqlite-shm`, and `database.sqlite-journal` sidecars are not valid current-bundle members.

Creation first uses SQLite's online backup API, so committed data still resident in the live source WAL is captured without copying or checkpointing the source main file. While the destination bundle is still `.incomplete`, creation reads the exact sidecar-free online-backup bytes, validates the SQLite header, changes only a valid destination `2/2` journal header to `1/1` in a private copy, runs query-only `quick_check`, and atomically replaces `database.sqlite` with that normalized representation using restrictive permissions. It then re-reads and requires persisted `1/1`, computes size and SHA-256 from those final bytes, copies the matching secure documents, writes manifest v2, runs ordinary verification, and only then renames the bundle into place. Ordinary v2 verification never normalizes a stored `2/2` file: even with a matching manifest checksum, it fails closed.

Manifest-version-1 bundles are historical, pre-invariant artifacts. Their stored bytes may be useful for forensic or explicitly reviewed recovery work, but ordinary verification reports them as `legacy` with `ok: false`; they are not eligible for normal restore or repair apply evidence and are never rewritten in place. Retention preserves legacy bundles rather than treating inability to prove the v2 standalone invariant as corruption. A malformed manifest, a database checksum or size mismatch, a missing database or manifest, or a failed database/document consistency check is classified as genuinely `invalid`.

```sh
npm run backup:verify -- --bundle /data/backups/backup-...
```

Run the automated recovery drill from a full repository checkout after recovery-related changes and at least monthly:

```sh
npm run backup:drill
```

The drill creates realistic SQLite/document data, snapshots it, checks retention and hashes, restores it to temporary paths, opens the restored database, runs SQLite integrity verification, and reads the restored confidential file.

A secure document whose checksum or size no longer matches the manifest, or whose bundled file is missing, makes a v2 bundle `degraded`, not `invalid`. The database snapshot of a degraded bundle is verified and intact, and degraded bundles are never automatically deleted by the 24-hour cleanup (they still count toward count retention). Only database or manifest problems make a bundle `invalid`. The one document-related exception is a manifest document path that resolves outside the bundle, which stays `invalid`. Because bundled documents are hardlinks, a degraded bundle usually means the live vault file itself was changed in place, so every bundle holding that file degrades together.

The Operations backup status reports current-valid, degraded, legacy, invalid, and incomplete bundle counts, and lists the affected document ids. A current-valid newest backup alongside any degraded, legacy, invalid, or incomplete artifact is reported as degraded; legacy-only inventory reports that no current fully verified backup is available. In-progress bundles carry a process marker, and retention preserves both live work and every recent `.incomplete` directory. Incomplete and invalid bundle directories older than 24 hours are treated as abandoned and removed on the next successful retention pass only when no marked backup process is still running. Legacy bundles are excluded from that automatic cleanup and from current age/count pruning. Investigate degraded status before the grace period expires if an invalid or incomplete artifact is needed for diagnosis.

The Operations page does not re-hash every bundle on each load. Each full verification records its result in `BACKUP_DIRECTORY/.verification-cache/<bundle>.json` with a fingerprint of the exact manifest bytes and the device, inode, size and modification time of the bundle's database snapshot, possible SQLite sidecars and every manifest document. A status read reuses a recorded result only while that fingerprint still matches and every fingerprinted file is more than two seconds older than the recorded check; any other bundle is verified again, newest first, in one shared background pass. Bundles still being checked after five seconds are shown as `verifying` and the page asks for a refresh. Retention (every nightly backup run), `npm run backup:verify` and restore always perform full verification, and the nightly retention pass refreshes every record. A change that keeps a file's size and modification time (for example silent media corruption) is caught by that nightly pass or by `npm run backup:verify -- --bundle ...`, not by the next page load. The server also warms missing records in the background at startup. Deleting `.verification-cache` is safe: it only makes the next status read verify every bundle again.

**Never write over a vault file in place.** Do not `cp` onto an existing vault path and do not use `rsync --inplace`: an in-place write changes the shared inode and therefore every backup bundle at once. Write the new content to a temporary name in the same directory and `mv` it over the vault path, which replaces the directory entry and leaves the bundles holding the original bytes.

The slim production image does not include the test suite. On a Fly Machine, perform the equivalent rehearsal with `backup:verify` and `backup:restore` into `/tmp` as shown below.

## On-demand application backup and Fly snapshot

Before a risky deployment or data migration:

```sh
fly ssh console -a uckele-group -C "cd /app && npm run backup:create"
fly volumes list -a uckele-group
fly volumes snapshots create <volume-id> -a uckele-group
fly volumes snapshots list <volume-id> -a uckele-group
```

Wait until the new Fly snapshot reaches `created`. Fly’s current commands and snapshot lifecycle are documented in [Manage volume snapshots](https://fly.io/docs/volumes/snapshots/) and the [`fly volumes snapshots` reference](https://fly.io/docs/flyctl/volumes-snapshots/).

For an existing Fly volume, confirm its retention and update it if needed:

```sh
fly volumes list -a uckele-group
fly volumes update <volume-id> --snapshot-retention 14 -a uckele-group
```

## Application-bundle restore

Never restore over the live database while the application Machine is writing to it.

1. Select and verify the backup bundle.
2. Stop the application Machine or scale the application to zero.
3. Prefer a rehearsal into temporary destinations first.
4. Restore live only after the rehearsal succeeds.
5. Start one Machine, inspect `/api/ready` and the Operations page, then test one secure-document download.

Rehearsal:

```sh
npm run backup:restore -- \
  --bundle /data/backups/backup-... \
  --database /tmp/recovery-drill/restored.sqlite \
  --documents /tmp/recovery-drill/secure-documents
```

Live restore with the application stopped:

```sh
npm run backup:restore -- \
  --bundle /data/backups/backup-... \
  --confirm-live
```

A degraded bundle is refused by default. If the vault file changed in place, first check the live vault file and recover it from a Fly volume snapshot; restoring a bundle also rolls the database back to the bundle's date. Only if you must restore the database from a degraded bundle, add `--accept-degraded-documents`: it restores the verified database plus the documents as stored in the bundle, skips documents whose bundled file is missing and lists them in the result's `degradedDocuments`. It never accepts an `invalid` bundle. Documents restored this way may be the damaged bytes; compare them with the Fly snapshot copy.

The restore command refuses a live destination without `--confirm-live`, requires a current manifest-v2 bundle with persisted `1/1` database bytes, verifies the complete bundle before copying, cleans its temporary staging directory after both success and failure, and retains the prior database and document directory with a `.before-restore-...` suffix. Current-format restore uses the stored rollback-format database naturally and does not depend on WAL/SHM/journal sidecars. Do not delete those safety copies until the restored application has passed validation.

## Fly volume-snapshot restore

Fly restores a snapshot into a new volume of equal or greater size; it does not overwrite the current volume in place. The documented flow is:

```sh
fly volumes list -a uckele-group
fly volumes snapshots list <old-volume-id> -a uckele-group
fly volumes create uckele_group_data \
  --snapshot-id <snapshot-id> \
  --size <size-gb> \
  --region ewr \
  -a uckele-group
```

Then attach the restored volume to a replacement Machine using the Fly dashboard or Machine/scale workflow, leaving the damaged volume untouched until validation is complete. Fly’s official restore instructions require a new volume with equal or greater size; see [restore a volume from a snapshot](https://fly.io/docs/volumes/snapshots/#restore-a-volume-from-a-snapshot).

## Recovery acceptance checklist

- `npm run backup:verify` reports `ok: true`.
- SQLite `quick_check` reports `ok`.
- Restored secure-document count equals the manifest count, except after an accepted degraded restore, which reports the skipped documents in `degradedDocuments`.
- At least one confidential document opens through the authenticated admin download route.
- Admin login and session revocation work.
- Operations shows healthy database/disk state and no unresolved cleanup failure.
- CRM record totals and a sampled deal timeline match expectations.
- The old volume/database safety copy remains available until sign-off.
