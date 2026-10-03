# P8-02 Secure CIM Attachment Foundation

**Status:** Owner-approved offline implementation design

**Date:** 2026-10-03

**Baseline:** `e16f370aa8b33e58f61cf9c67ac44e4982c65c33`

## Objective

Persist inbound CIM attachment bytes in a private quarantine, prove their type and integrity, scan them through a replaceable adapter, and require an explicit owner business/type decision before publishing a clean file into the existing secure document vault. The implementation is offline infrastructure only: it does not fetch provider attachments, expose quarantined bytes, install a scanner, infer document facts, activate cadence, or change production.

## Security boundary and invariants

Attachment metadata and bytes are hostile input. They are data, never instructions. Provider IDs, names, declared MIME types, and stream sizes are bounded before persistence. The implementation:

1. uses one `secure_attachment_ingestions` row per provider attachment lifecycle and provenance record;
2. keeps quarantine below one configured, owner-controlled root with directory mode `0700` and file mode `0600`;
3. exposes no HTTP download route for quarantine;
4. accepts an injected byte stream only and performs no provider or network call;
5. caps the stream at the existing secure-vault per-file maximum and a hard 30-second elapsed-time default, validates MIME from magic bytes, and records SHA-256 and actual size;
6. treats the unique `(provider, provider_message_id, provider_attachment_id)` tuple as the replay identity;
7. creates a separate provenance row for a distinct provider tuple with duplicate bytes, but points it at the same content-addressed quarantine object;
8. never logs, parses, renders, or sends attachment contents;
9. requires a deterministic scanner adapter result of `clean`, `unsafe`, or `unavailable`; only a deterministic fake is included;
10. requires `clean` plus a fresh owner approval naming `submissionId`, `documentType`, and actor before vault publication;
11. rejects approval when the inbound communication is unassigned, assigned to another submission, or ambiguous, and records a bounded hold reason;
12. leaves quarantine in `HOLD`; there is no automatic or permanent-purge operation;
13. validates that every read, write, copy, and cleanup path is owned by the expected quarantine or vault root; and
14. never lets observed metadata, quarantine state, or scan state satisfy the existing materials predicate. Only a published `secure_documents` row can do so.

## Lifecycle

```text
metadata-observed
  -> bounded private partial -> quarantining (durable row) -> scan-pending
  -> clean -> awaiting-owner-approval -> publishing -> published
  -> unsafe (terminal HOLD)
  -> scan-unavailable (retryable, bounded attempts, then HOLD)
  -> rejected before persistence (invalid provenance/size/type/content; no row or bytes)
```

The lifecycle row owns provider provenance, observed communication/assignment, declared and detected type, safe file name, actual size, SHA-256, quarantine relative path, duplicate provenance, scan attempts/results, owner approval, retry state, retention state, and frozen vault publication intent/result. Raw attachment bytes, quoted message content, credentials, and signed URLs are never stored in the row.

## Capture and duplicate contract

`captureCimAttachment({ metadata, byteStream, storage, quarantineRoot, maxBytes, maxDurationMs })` is the offline ingress seam. It first verifies that the referenced communication exists, is inbound, and has the same provider/message provenance. A second call for the same provider tuple returns or recovers the existing row without reading the new stream. Capture writes `.partial-<intake-id>`, incrementally hashes and hard-caps it by bytes and elapsed time, validates its signature against the declared allowed vault MIME family, fsyncs it, then persists a `quarantining` lifecycle row before atomically linking the bytes to `<sha256>.<safe-extension>`. It removes the partial only after the canonical object is verified and advances the row to `scan-pending`. A distinct tuple with the same SHA-256 records `duplicate_of_id` and reuses the canonical quarantine path, including when both captures race.

Stream overflow, invalid magic, unexpected stream failure, link failure, and disk-full before the database boundary leave no owned temporary file and no publishable state. Because a lost database response is indistinguishable from a rejected insert, an insert error conservatively retains only the root-owned `.partial-<intake-id>` until replay/reconciliation or the bounded stale-partial sweep; it never creates an untracked canonical object. Failures never delete an existing canonical object. A crash after row persistence leaves either `.partial-<intake-id>` or the verified canonical object attached to a `quarantining` row. Replay or restart reconciliation completes that row without rereading provider bytes; cleanup removes only stale, unclaimed, regular, root-owned partial files and never follows symbolic links.

## Scanner and retry contract

`scanCimAttachment` receives an injected adapter. The repository ships `createDeterministicFakeScanner`, which produces only configured deterministic outcomes and makes no external calls. No production scanner is selected by default.

An unavailable scanner records a bounded attempt, retry time, and visible hold reason. The three-attempt default permits retry after 15 minutes and then 2 hours; a third unavailable result records `retry_exhausted` in HOLD with no further automatic retry. Calls before `next_scan_at` are rejected without invoking the scanner. The service does not schedule retries; a caller must invoke it. Unsafe rows record an `unsafe` hold reason for owner review and can never be approved or published.

## Owner approval and vault publication

`publishApprovedCimAttachment` requires an explicit owner actor, submission ID, and normalized existing vault document type. It reloads the intake, communication, and submission assignment at decision time. A prior assignment snapshot is provenance only and grants no authority.

The first approved publication freezes request/document IDs and destination relative path in the lifecycle row. Publication copies from quarantine to a root-owned vault temporary file, fsyncs, atomically renames, then atomically creates the existing `secure_upload_requests` and `secure_documents` records and marks the intake published. Retries use the frozen intent:

- crash after vault rename but before DB commit: the next call verifies the existing file hash and resumes the same DB mutation;
- DB commit succeeds but the response is lost: the next call returns the published row;
- disk-full/copy failure: only the root-owned temporary file is removed and the lifecycle remains retryable;
- changed business, type, or actor after intent is frozen: reject instead of repurposing the intent.

SQLite performs final record creation and lifecycle transition in one immediate transaction. Supabase exposes an equivalent service-role-only RPC. This branch adds and tests migrations locally but does not apply them to production.

## Retention and backup

Every row defaults to `retention_status='hold'` and gets a review timestamp 30 days after capture. That timestamp is advisory; no timer deletes data. The backward-compatible manifest v2 format gains a quarantine-object section that is optional only when the database snapshot has no attachment lifecycle rows. When rows exist, verification requires the exact intake/object set with matching size and SHA-256. Existing v1/v2 bundles without lifecycle rows remain readable. Restore writes quarantine bytes beneath the configured root and rewrites restored lifecycle paths; ambiguous, missing, symlinked, or unsafe paths fail closed.

## Owner-visible projection

The existing attachment projection may report sanitized lifecycle counts/status (observed, quarantined, scan pending/unavailable, unsafe, awaiting approval, published) without file names, provider IDs, hashes, or paths. It must continue to report `materialsReceived=false` until the existing material authority observes the published vault document.

## Success criteria

- SQLite and Supabase schemas express the same constraints and indexes.
- Replay and content duplicate behavior is idempotent.
- Hard stream limit, invalid MIME/magic, unsafe scan, scan unavailable, ambiguous assignment, wrong business, restart, disk-full, and both publication crash windows are covered by deterministic offline tests.
- Backup create/verify/restore covers referenced quarantine objects and rejects tampering/path escape.
- No route serves quarantine and no default scanner or provider byte fetch exists.
- Focused tests, eval, lint, full tests, UI tests, and build pass under Node 22.
- An independent reviewer finds no unresolved critical/high issue before commit and draft PR.

## Non-goals

Provider attachment download, live credentials/calls, scanner installation/signature download, OCR/AI extraction, financial fact extraction, automatic business association, automatic purge, UI workflow expansion, provider/cadence activation, production migration, merge, or deploy are explicitly out of scope.
