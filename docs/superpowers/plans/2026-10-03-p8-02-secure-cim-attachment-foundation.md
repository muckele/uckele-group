# P8-02 Secure CIM Attachment Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the owner-approved offline foundation that quarantines, scans, holds, approves, and publishes inbound CIM attachments without live provider or scanner access.

**Architecture:** One `secure_attachment_ingestions` provenance/lifecycle row owns an exact provider-message-attachment identity while content-addressed files remain private under the existing vault root. Injected streams and scanners are the only byte/scan seams; clean files enter existing secure-document authority only through a frozen, owner-approved, crash-resumable transaction.

**Tech Stack:** Node.js 22, ESM, `node:test`, SQLite/`better-sqlite3`, Supabase PostgreSQL fixtures, existing filesystem vault and backup services.

**Spec:** `docs/superpowers/specs/2026-10-03-p8-02-secure-cim-attachment-foundation-design.md`

## Global Constraints

- Base exactly `e16f370aa8b33e58f61cf9c67ac44e4982c65c33`; offline source/tests/local migration fixtures and draft PR only.
- No provider/network/AI calls, live attachment bytes, scanner installation/signature download, credentials, new domains, mail, cadence activation, spending, production migration, merge, deploy, or fact extraction.
- Quarantine is private, has no download route, reuses existing vault/cleanup/backup contracts, and defaults every object to retention HOLD with no permanent purge.
- Observed metadata, quarantine, and scan state never satisfy `materialsReceived`; only an existing `secure_documents` publication can.

## Review Focus

- Concurrent exact-identity and same-content captures converge without duplicate lifecycle authority or orphan bytes.
- Stream overflow, elapsed-time expiry, MIME mismatch, disk-full, and crash windows leave only recoverable root-owned state.
- Unsafe, assignment-ambiguous, wrong-business, unavailable, and retry-exhausted rows remain visibly held and unpublished.
- Publication rechecks current inbound assignment, clean scan, frozen owner/business/type intent, and secure path/hash ownership.
- Backup/restore rejects missing, tampered, symlinked, ambiguous, or escaping quarantine objects while preserving old bundles.

---

### Task 1: Lifecycle schema and storage parity

**Files:** `server/storage/sqlite.js`, `server/storage/supabase.js`, `supabase/schema.sql`, `supabase/migrations/20261011120000_secure_cim_attachment_foundation.sql`, `test/cimAttachmentStorageContract.test.js`

**Interfaces:** Produces the existing `get/insert/update/listCimAttachmentIntake` methods and atomic `publishCimAttachmentToVault` over the single `secure_attachment_ingestions` table.

- [x] Write and run failing SQLite/Supabase contract tests for exact identity uniqueness, service-role isolation, HOLD fields, and atomic publication.
- [x] Add the minimal additive local schemas and storage methods.
- [x] Run `node --test test/cimAttachmentStorageContract.test.js` under Node 22.

### Task 2: Private bounded capture and deduplication

**Files:** `server/services/cimAttachmentIntake.js`, `server/services/documentVault.js`, `test/cimAttachmentIntake.test.js`

**Interfaces:** Produces `captureCimAttachment({ metadata, byteStream, storage, quarantineRoot, maxBytes, maxDurationMs })` and restart recovery/partial cleanup.

- [x] Write and run failing tests for hard byte/time bounds, MIME magic, hashing, replay, duplicate races, disk-full, symlink/path escape, and restart recovery.
- [x] Implement private `0700`/`0600` content-addressed quarantine using only an injected stream.
- [x] Run the focused capture tests under Node 22.

### Task 3: Injected scan and visible holds

**Files:** `server/services/cimAttachmentIntake.js`, `test/cimAttachmentIntake.test.js`

**Interfaces:** Produces `createDeterministicFakeScanner` and `scanCimAttachment`; consumes lifecycle storage and root-owned quarantine files.

- [x] Write and run failing tests for clean, unsafe, unavailable, retry timing, and retry exhaustion.
- [x] Implement the fake-only adapter and bounded hold reasons without a scheduler or default production scanner.
- [x] Run the focused scan tests under Node 22.

### Task 4: Owner-approved vault publication

**Files:** `server/services/cimAttachmentIntake.js`, `server/storage/sqlite.js`, `server/storage/supabase.js`, Supabase fixtures, `test/cimAttachmentIntake.test.js`

**Interfaces:** Produces `publishApprovedCimAttachment`; consumes clean scan state, current inbound assignment, owner actor/business/type, and existing secure vault records.

- [x] Write and run failing tests for absent/wrong/ambiguous assignment, frozen approval, disk-full, both crash windows, restart, and unchanged materials authority.
- [x] Implement root-owned copy/rename and one atomic request/document/lifecycle commit.
- [x] Run focused publication and authority tests under Node 22.

### Task 5: Backup, restore, and existing repair contracts

**Files:** `server/services/backups.js`, `server/repairs/canonicalOpportunityMerge.js`, related tests.

**Interfaces:** Extends existing manifest v2 and relationship inventory without changing old-bundle compatibility.

- [x] Write and run failing quarantine backup/restore/tamper/path tests.
- [x] Add exact referenced object manifests, path rewriting, and relationship classification.
- [ ] Run focused backup and canonical-repair tests under Node 22.

### Task 6: Verification, independent review, and draft PR

**Files:** Entire branch diff and CI configuration.

**Interfaces:** Produces a reviewed branch and draft PR only; no merge, deploy, production migration, or activation.

- [ ] Run focused tests/eval, lint, full unit/UI suites, and build under Node 22.
- [ ] Obtain independent security/correctness review and resolve all critical/high findings.
- [ ] Commit the reviewed exact head, push the isolated branch, open a draft PR, and verify full CI for that head.
