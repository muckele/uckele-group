# SQLite and secure-document recovery

Phase 16 uses two complementary recovery layers:

1. The application creates an application-consistent SQLite snapshot and copies every secure document referenced by that snapshot into a checksummed backup bundle under `BACKUP_DIRECTORY` (default: beside the SQLite database in `backups/`). The bundle is written privately, renamed into place only after it is complete, verified with SQLite `quick_check`, and retained by both age and count.
2. Fly takes daily snapshots of the `/data` volume. `fly.toml` requests 14-day retention for newly created volumes. Fly documents a five-day default and a configurable 1–60 day retention window; existing volumes must be updated separately. See [Fly volume snapshot management](https://fly.io/docs/volumes/snapshots/).

Application backups on the same Fly volume protect against inconsistent SQLite/file copies and operator mistakes. Fly volume snapshots protect the complete volume when the active volume is damaged or replaced. For materially stronger disaster recovery, copy verified application bundles to a separately controlled encrypted store; do not treat a single volume as an offsite backup.

## Routine verification

Check the Operations page for the most recent backup, database integrity, disk capacity, and failed backup job. From an authorized shell:

```sh
npm run backup:verify
```

This verifies the newest bundle, including the complete manifest schema, SQLite snapshot integrity, one-to-one correspondence between every secure-document manifest entry and its SQLite row, manifest row counts, and every recorded size and checksum. A malformed or row-mismatched manifest is never considered restorable, even when it represents a database with no secure documents. To select a bundle:

```sh
npm run backup:verify -- --bundle /data/backups/backup-...
```

Run the automated recovery drill from a full repository checkout after recovery-related changes and at least monthly:

```sh
npm run backup:drill
```

The drill creates realistic SQLite/document data, snapshots it, checks retention and hashes, restores it to temporary paths, opens the restored database, runs SQLite integrity verification, and reads the restored confidential file.

The Operations backup status also reports valid, invalid, and incomplete bundle counts. A valid newest backup with a recent invalid or incomplete artifact is reported as degraded. In-progress bundles carry a process marker, and retention preserves both live work and every recent `.incomplete` directory. Incomplete and invalid bundle directories older than 24 hours are treated as abandoned and removed on the next successful retention pass only when no marked backup process is still running. Investigate degraded status before that grace period expires if the failed artifact is needed for diagnosis.

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

The restore command refuses a live destination without `--confirm-live`, verifies the complete bundle before copying, cleans its temporary staging directory after both success and failure, and retains the prior database and document directory with a `.before-restore-...` suffix. Do not delete those safety copies until the restored application has passed validation.

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
- Restored secure-document count equals the manifest count.
- At least one confidential document opens through the authenticated admin download route.
- Admin login and session revocation work.
- Operations shows healthy database/disk state and no unresolved cleanup failure.
- CRM record totals and a sampled deal timeline match expectations.
- The old volume/database safety copy remains available until sign-off.
