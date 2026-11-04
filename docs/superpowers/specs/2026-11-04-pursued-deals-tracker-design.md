# Pursued Deals Tracker — Design

**Date:** 2026-11-04
**Status:** Draft for owner review (revision 3, after principal-engineer review and re-review: READY WITH CHANGES, changes applied)
**Delivery:** two PRs. PR A is the backup hardlink change (§8.2); PR B is the tracker, which depends on PR A.
**Baseline:** `origin/main` at `0687eb7`. Every `file:line` below refers to that commit.
**Builds on:** `2026-11-03-gmail-send-runners-design.md` (PR #86)

## 1. Purpose

After a broker replies to a SIM request, the reply poller stops the campaign. From that point the deal no longer appears on any list the owner works from:

- **Needs Your Action** only counts replies whose `source = 'resend-webhook'` (`server/storage/sqlite.js:11888-11901`, `supabase/schema.sql:9235-9238`).
- Gmail replies are stored only in `deal_hunter_gmail_reply_messages` (`sqlite.js:5613-5629`) and as conversation terminal events (`server/services/pursueCimInbound.js:14-24`).
- Pursued deals are deliberately left out of every criteria area (`server/services/dealHunterFreshInboxPolicy.js:19-34`).
- A bounce leaves the campaign `action-required` with reason `recipient_bounced` (`pursueCimReplyPoller.js:12-15`), and no screen lists it.

This design adds four things:

- a **Pursued deals** tab that lists every pursued deal at exactly one stage;
- a **Broker replies** block inside Needs Your Action, with an Open-in-Gmail link on each item;
- a one-click reply type;
- an owner upload of the SIM PDF into the document vault.

It sends no email and stores no email bodies. Exactly one write path changes campaign state: the SIM upload stops follow-ups, through the existing materials rule (§6.3).

## 2. Owner decisions (final, 2026-11-04)

| # | Decision |
|---|---|
| 1 | A tab listing every pursued deal at one stage: SIM requested, Broker replied, NDA, SIM received, Reviewing, LOI candidate, or Passed. Nothing beyond LOI candidate. New replies and bounces also appear in Needs Your Action, with a link to the Gmail thread. |
| 2 | The owner uploads the SIM PDF from Gmail into the deal's vault. The upload marks materials received. Automatic capture of attachments is out of scope. |
| 3 | The owner sets a reply type with one click: NDA requested, SIM received, Not available, Question, or Other. The stage moves to match. No AI. |
| 4 | **Not available** moves the deal to Passed **in this tab only**. The owner can undo it. It never runs the CRM or Deal Hunter Pass. |

**Decision: the tab is labeled "Pursued deals", not "Pursuing".**
- *Why:* the default inbox already has an area named "Pursuing automatically" (`src/components/admin/AcquisitionInbox.jsx:1293`, `:1329`). Two "Pursuing" labels one click apart would confuse the owner.
- *Cost if wrong:* a one-string rename.

## 3. Non-goals

- Sending, drafting, or replying to email.
- Changing the poller, the sender, transmissions, or the final gate.
- Storing bodies, subjects, or snippets.
- The inbox SQL, including `list_deal_hunter_fresh_inbox_v1`, does not change.
- The Command Center mapping does not change. `deriveAcquisitionPipelineStage` puts CRM diligence first (`acquisitionCommandCenter.js:536-556`). A pursuit mapping placed ahead of it would pull deals already at `financial-review` back down a stage.
- CRM `metadata` is never written.
- No stages after LOI candidate.
- No antivirus scanning; the repo has none (§8.5).

## 4. Data model & storage

### 4.1 Stage vocabulary

The tracker reuses the stage ids that already exist in code:

| Id | Owner label | Existing source |
|---|---|---|
| `cim-requested` | SIM requested | `submissions.js:48`, `acquisitionCommandCenter.js:17` |
| `broker-replied` | Broker replied | `acquisitionCommandCenter.js:18` |
| `nda-sent` | NDA | `submissions.js:49` |
| `cim-received` | SIM received | `submissions.js:50` |
| `financial-review` | Reviewing | `submissions.js:51` |
| `loi-candidate` | LOI candidate | `submissions.js:53` |
| `passed` | Passed | `submissions.js:54` |

Stage order follows the table. Code names stay CIM; the UI always says "SIM".

### 4.2 Projection, not a stored stage

**Decision: stage is computed when read.** It is a fold over existing evidence plus a new append-only owner-event table.
- *Why:* the poller and the vault already record replies and documents durably. Storing the stage in a column would mean PR #86's poller also has to write that column. An append-only log follows the owner-decision audit pattern (`sqlite.js:4569-4589`, with triggers at `:5054-5065`).
- *Cost if wrong:* reads cost O(deals × evidence). If volume grows past a few thousand deals, we add a cache rebuilt from the same fold.

### 4.3 Table `deal_hunter_pursuit_stage_events`

The table is immutable in both adapters, through no-update, no-delete and no-replace triggers copied from `sqlite.js:5054-5065`.

| Column | Notes |
|---|---|
| `id` (PK) | UUID, set by the server |
| `idempotency_key` (UNIQUE) | Client UUID, validated with the regex at `dealHunterTriage.js:1222-1225` |
| `request_digest` | sha256 over `pursuit-stage-request:v1` and all command fields; for an upload, also the byte length and sha256 of the file. Same idea as `pursueCimSqliteTransitions.js:4120-4128`. |
| `opportunity_id` | FK, `ON DELETE RESTRICT` |
| `previous_event_id` | NOT NULL. The prior event's id, or `'genesis'`. **UNIQUE (`opportunity_id`, `previous_event_id`)** |
| `kind` | `reply-type`, `stage-move`, `sim-intake`, or `acknowledge` |
| `reply_type` | `nda-requested`, `sim-received`, `not-available`, `question`, `other`, or null |
| `from_stage`, `stage` | The projected stage before the event, and the stage after it |
| `acknowledged_reply_id`, `acknowledged_processed_at` | The Gmail message id the owner saw, and that row's `processed_at` as the server copied it. Nullable. |
| `secure_document_id` | Set only when `kind = sim-intake` |
| `actor`, `policy_version` (`pursuit-tracker-v1`), `created_at` | |

There is an index on (`opportunity_id`, `created_at DESC`). The table has no free-text column, so email content cannot be pasted into it.

**Decision: a database constraint serializes writes.**
- The UNIQUE predecessor rule uses a non-null `'genesis'` sentinel, because SQLite's UNIQUE allows many NULLs.
- SQLite writes run in one `.immediate()` transaction (the pattern at `sqlite.js:1140`).
- Postgres RPCs first run `SELECT … FROM deal_hunter_opportunities WHERE opportunity_id = $1 FOR UPDATE`, then read the latest event under that lock.
- Result: an append that doesn't name a predecessor (an upload or acknowledge) can never lose a race with a 409.
- `reply-type` and `stage` writes compare `expectedLatestEventId` under the same lock.
- *Cost if wrong:* a stale tab gets a 409 and refreshes, which is the intended behavior.

### 4.4 Adapters

**SQLite.** Add `CREATE TABLE IF NOT EXISTS` beside the decision tables (`sqlite.js:4569`). Add three methods:
- `listPursuitBundles({ stage, limit })`
- `recordPursuitStageEvent(cmd)`
- `recordPursuitSimIntake(cmd)` (§8.4)

**Supabase.** Migration `supabase/migrations/20261105120000_pursuing_tracker.sql`, mirrored in `supabase/schema.sql`. It contains:
- the table and its triggers, with RLS on and access for `service_role` only (as in `20261103120000_gmail_send_runners.sql:45-52`);
- three `security definer` RPCs, each with `search_path = public` and execute rights for `service_role` only:
  - `pursuit_tracker_list_v1`
  - `pursuit_tracker_record_event_v1`
  - `pursuit_tracker_record_sim_intake_v1`

**Bundle.** Both adapters return the same bundle per opportunity. It holds:
- every owner decision, with its `action` and `created_at`;
- the latest campaign generation and its conversation `gmail_thread_id` (`sqlite.js:5937-5939`, `schema.sql:21058-21062`);
- the Gmail reply rows for that conversation;
- the CIM-type `secure_documents` rows (`document_type` in `cimDocumentTypes`, `acquisitionMaterials.js:17-25`) on that campaign's **`crm_submission_id`**;
- that submission's `diligence.stage` with `diligence.updated_at` (`submissions.js:198`), and `acquisitionCommand.pipelineStage` with `updatedAt` (`acquisitionCommandCenter.js:2055-2059`);
- the owner tracker events.

**Decision: `crm_submission_id` is the only submission link.** The tracker never uses `primary_submission_id` (`sqlite.js:11906`).
- *Why:* materials convergence and the sender read `campaign.crm_submission_id` (`pursueCimSqliteTransitions.js:1577-1582`). A SIM filed on another submission would not stop follow-ups.
- *Cost if wrong:* a deal with no campaign can't receive an upload (409 `no_crm_record`).

## 5. Stage derivation

### 5.1 Membership

Membership depends on the opportunity's **latest** owner decision:

| Latest decision | Shown |
|---|---|
| `pursue` (manual or `auto-pursue-v1`) | Listed. The fold starts at that decision's `created_at`. |
| `pass`, after any pursue | Listed under Passed with the note "Passed in Deal Hunter". Read-only here; the existing Restore undoes it. |
| `watch`, after a pursue | Not listed. On Postgres this decision also stops the campaign (`schema.sql:18805-18811`). |

A new pursue after a Restore starts again at `cim-requested`. Earlier tracker events and earlier campaign generations are ignored. Documents and CRM stages dated before that pursue are applied at the pursue instant.

### 5.2 Fold

The pure function `foldPursuitStage(bundle)` lives in `server/services/pursuitTracker.js`. It sorts events by (instant, then system evidence before owner events, then id).

| Event (instant) | Effect on stage | Needs Your Action |
|---|---|---|
| Latest `pursue` decision | Start at `cim-requested` | — |
| Gmail row classified `reply` or `stop` (`processed_at`) | Move forward to `broker-replied` | `reply` (§5.3) |
| Gmail row classified `bounce` | None | `bounce`, while the campaign is `action-required` / `recipient_bounced` |
| Gmail row classified `owner`, `auto-reply`, or `ours` | None | None |
| CIM-type `secure_documents` row (`created_at`) | Move forward to `cim-received` | — |
| CRM `diligence.stage` (`updated_at`): `cim-requested` → `cim-requested`; `nda-sent` → `nda-sent`; `cim-received` → `cim-received`; `financial-review` or `lender-review` → `financial-review`; `loi-candidate` → `loi-candidate`; `passed` → `passed`; `not-started` → none | Move forward | — |
| CRM `pipelineStage` (`updatedAt`): `cim-requested` → `cim-requested`; `broker-replied` → `broker-replied`; `docs-received` → `cim-received`; `diligence` → `financial-review`; `loi-candidate` → `loi-candidate`; `passed` → `passed`; `new-fit` → none | Move forward | — |
| Owner `stage-move` | Set to exactly `stage`, in either direction | Acknowledges |
| Owner `reply-type` | `not-available` → `passed`. `nda-requested` → max(current, `nda-sent`). `sim-received` → max(current, `cim-received`). `question` or `other` → max(current, `broker-replied`). | Acknowledges |
| Owner `sim-intake` | max(current, `cim-received`) | Acknowledges, if an ack id was sent |
| Owner `acknowledge` | Unchanged | Acknowledges |

Rules for the fold:
- System evidence only moves the stage forward, and never moves it out of `passed`. Only an owner `stage-move` reopens a deal.
- A `prospectus_url` is **never** evidence. `evaluateAcquisitionMaterialsState` counts it as materials (`acquisitionMaterials.js:96-99`), but the fold only uses the specific rows listed above.
- `stageSince` is the instant of the event that last changed the stage. `stageSource` is `owner` or `evidence`.

### 5.3 Attention

The acknowledgement point is the **largest** (`acknowledged_processed_at`, `acknowledged_reply_id`) over all events that have one. A Gmail row needs attention when its (`processed_at`, `gmail_message_id`) is greater than that point.

**Decision: attention is ordered by `processed_at`, not by Gmail `internalDate`.**
- *Why:* after a checkpoint expires, the poller can record old messages late (`pursueCimReplyPoller.js:3-7`). Ordering by message date would treat such a message as already acknowledged.
- *Cost if wrong:* the same reply can appear twice. One click clears both.

## 6. API routes

All routes sit with the other `/api/admin/deal-hunter` routes in `server/app.js`.
- **Reads** use `requireAdminAccess`, which allows admin and viewer (`auth.js:200-208`).
- **Writes** use `requireAdmin` (`auth.js:190-198`).
- **Idempotency:** the same key with the same digest replays (`200 {replay:true}`). The same key with a different digest returns `409 idempotency_conflict`.

### 6.1 `GET /api/admin/deal-hunter/pursuing?stage=<id|needs-action|all>`

Returns `200 { asOf, counts: { needsAction, byStage }, rows, truncated }`.

- Rows come back as one page of at most 200. Needs-action rows come first, oldest first; the rest are ordered by stage, then by `stageSince` descending.
- `truncated` is true when more than 200 rows exist. The counts are always exact.
- Errors: `400 invalid_stage`, `401`.

Each row contains:
- `opportunityId`, `name`, `crmSubmissionId`
- `stage`, `stageLabel`, `stageSince`, `stageSource`
- `lastReplyAt` (`message_at`, for display)
- `needsAction: null | {reason, at, classification}`
- `simDocuments: [{id, name, sizeBytes, uploadedAt}]`
- `latestEventId`
- `release`: from `getPursueCimReleaseReport` (`pursueCimRelease.js:143-230`). It carries `status {code, reason, actionRequired}`, `canStop`, and `campaign {id, state, rowVersion, terminalRevision}`. These are exactly the inputs the existing stop route needs (`pursueCimRelease.js:295-306`).
- **Admin only:** `gmailThreadUrl` and `needsAction.replyId`. **Viewers receive neither a thread id nor a message id.**

**Decision: rows reuse the release report rather than adding new outreach labels.**
- The UI shows `release.status.code` the same way the drawer does.
- The report is computed per row. If one row's report throws (a binding mismatch, `:181-188`), that row shows "Status unavailable" and the rest of the page still loads.
- *Cost if wrong:* on Postgres, the 200 projection reads run 8 at a time. If that is too slow, we add a batched projection read.

### 6.2 Writes

| Route | Body | Success | Errors |
|---|---|---|---|
| `POST …/pursuing/:opportunityId/reply-type` | `{replyType, idempotencyKey, expectedLatestEventId, acknowledgedReplyId?}` | `200 {row, replay}` | `400 invalid_reply_type`; `404 not_pursued`; `409 pursuit_stage_changed`; `409 idempotency_conflict`; `422 unknown_reply` |
| `POST …/pursuing/:opportunityId/stage` | `{stage, idempotencyKey, expectedLatestEventId, acknowledgedReplyId?}` | `200 {row, replay}` | As above, plus `400 invalid_stage` |
| `POST …/pursuing/:opportunityId/acknowledge` | `{idempotencyKey, acknowledgedReplyId}` | `200 {row, replay}` | `404`; `409 idempotency_conflict`; `422 unknown_reply` |
| `POST …/pursuing/:opportunityId/sim` | Raw PDF body; headers in §8.1 | `201 {document, row}`, or `200 {replay:true}` | §8.1 |

The server copies `acknowledged_processed_at` from the stored Gmail row. The reply id must belong to the deal's conversation, otherwise `422`.

### 6.3 Which writes change campaign state

- **`reply-type`, `stage`, `acknowledge`:** tracker only. They never append a terminal event or touch a campaign.
  - If `release.canStop` is true afterwards, the UI offers the existing **Stop SIM requests** button (`POST …/triage/:id/cim-release/stop`, `app.js:1806-1825`).
  - *Cost if wrong:* the owner records "NDA" on a reply that came from outside the thread, forgets to press Stop, and a follow-up still goes out.
- **`sim`:** this one **does change campaign state.**
  - The intake inserts a CIM-type document on the campaign's `crm_submission_id` and runs the existing materials convergence (§8.4).
  - A campaign that is still `initial-pending` or `active-follow-up` moves to `materials-received`, and its scheduled touches are cancelled (`pursueCimSqliteTransitions.js:2885-2913`). The sender's materials check also blocks sends (`:1577-1604`).
  - This uses existing rules; no campaign code changes. The UI copy says so.

## 7. UI

### 7.1 Pursued deals tab

**Navigation.**
- `/admin/deal-hunter?view=pursued` gets a third pill in both nav bars (`AcquisitionInbox.jsx:1325`, `src/pages/DashboardPage.jsx:3927-3929`).
- `DashboardPage.jsx:1403-1404` gains `showDealHunterPursued` and lazy-loads `PursuedDeals.jsx`, the same way `:43` does.

**Header.**
- Title: **Pursued deals**
- Subtitle: "Every deal you've asked a broker for a SIM on, and where it stands."

**Chips.** "Needs your action (n)" (the default when n > 0), "All", and one chip per stage label.

**Each row shows:**
- the name, linking to the CRM record;
- a stage pill with "since {date}";
- the release status;
- "Replied {date}";
- **Open in Gmail** (admin only);
- a **Move to…** select;
- **Upload SIM**;
- uploaded SIMs, each linking to `/api/admin/secure-documents/:id/download` (`app.js:2998-3021`);
- **Stop SIM requests**, when `release.canStop` is true.

**When the row needs action:**

| Situation | Band text | Controls |
|---|---|---|
| Reply | "Broker replied {date} — what did they say?" | Reply-type control |
| Stop-word reply | Reply text plus "They asked not to be emailed again." | Reply-type control |
| Bounce | "SIM request bounced {date}." | **Open in Gmail**, **Stop SIM requests**, **Mark handled** |

### 7.2 Reply-type control (shared)

- Markup: `role="group" aria-label="Reply type for {name}"`.
- Buttons: **NDA requested**, **SIM received**, **Not available**, **Question**, **Other**.
- One click records the reply type. The page then shows "Recorded: {label}. Undo", and Undo records a `stage-move` back to `from_stage`.
- **SIM received** also opens the upload control, which the owner can dismiss with "Upload later".
- Idempotency keys live in a ref keyed by (deal, signature), following `AcquisitionInbox.jsx:672-674`.

### 7.3 Needs Your Action: "Broker replies" block

The inbox SQL is unchanged. Instead:
- `AcquisitionInbox` fetches `GET /pursuing?stage=needs-action` next to its auto-pursue status fetch (`:421`).
- It renders a **Broker replies** block inside the `action-preview` section, using the same structure as the "SIM requested automatically today" block (`:1305-1308`).
- Each item shows the name, "Replied {date}" or "Bounced {date}", **Open in Gmail**, and the reply-type control (or **Mark handled** for a bounce).
- A footer link reads "All pursued deals →".
- The section's "No opportunities in this area." text is hidden while the block has items.
- Delisted deals still show here, because membership comes from owner decisions, not from triage eligibility (`sqlite.js:11780`).

### 7.4 Gmail link

**Decision: the server builds the link:** `https://mail.google.com/mail/?authuser=<encodeURIComponent(address)>#all/<threadId>`.
- The thread id must match `^[A-Za-z0-9_-]{1,64}$` (the same family as `GMAIL_ID`, `pursueCimReplyPoller.js:41`).
- The address is the active connection's `email_address` (`sqlite.js:5573-5592`), falling back to `DEAL_HUNTER_GMAIL_SENDER_ADDRESS`.
- Rendered with `rel="noopener noreferrer" target="_blank"`. Admin responses only.
- *Why:* `authuser` picks the right mailbox when two Google accounts are signed in, and `#all` still finds archived threads.
- *Cost if wrong:* the link opens an empty view. Rollout step 3 checks this.

### 7.5 Copy

| Situation | Copy |
|---|---|
| None pursued | "No pursued deals yet. Deals you Pursue — or that are pursued automatically at 90+ — show up here." |
| Empty filter | "No deals at this stage." |
| Truncated | "Showing the first 200. Use a stage filter to see the rest." |
| Load error | "Pursued deals couldn't load." + **Retry** |
| 409 | "This deal changed in another tab. We refreshed it — check the stage and try again." |
| No thread | "Gmail thread not available yet." |
| Viewer | "Read-only access: stage changes and uploads are unavailable." |
| Upload errors | "Only PDF files can be uploaded as a SIM." / "This file is larger than 25 MB." / "That file isn't a valid PDF." / "The file name couldn't be read. Rename it and try again." / "Uploads are busy. Try again in 30 seconds." / "The server is low on storage space. Tell your engineer before uploading more." / "This deal has no CRM record yet, so a SIM can't be stored." |
| Upload OK | "SIM uploaded. Follow-ups for this deal have stopped." when `canStop` was true; otherwise "SIM uploaded." |

## 8. Upload handling

### 8.1 Route and checks

`POST /api/admin/deal-hunter/pursuing/:opportunityId/sim` is mounted ahead of every body parser (`app.js:736`). Middleware runs in this order:

1. **Admin check.** `requireAdmin` runs before the body is touched, following `app.js:698-715`.
2. **Capacity.** Shares `activeSecureUploads` and `maxConcurrentUploads` (default 2) with the public route. Same pattern as `app.js:651-674`, before any parsing; returns `503 upload_capacity` with `Retry-After: 30`.
3. **Header checks:**
   - `Content-Type` must be exactly `application/pdf`, else `415 pdf_only`.
   - `Content-Length` is required (`411`) and must be at most `SIM_MAX_BYTES = 25 MiB`, a constant (else `413`).
   - `X-Idempotency-Key` must be a UUID (`400`).
   - `X-File-Name` goes through `decodeURIComponent` inside `try`. A failure returns `400 invalid_file_name`. The name is then passed through the vault's `sanitizeFileName` (`documentVault.js:98`), capped at 180 characters, with `.pdf` appended if missing.
   - Optional: `X-Acknowledged-Reply-Id`.
4. **Replay.** If the idempotency key already exists, respond and `request.destroy()` without reading the body.
5. **Submission.** Resolve the latest campaign's `crm_submission_id`. If there is none, `409 no_crm_record`. Then call `assertCrmSubmissionWritable`; a superseded submission returns `409 crm_superseded`.
6. **Disk admission** (§8.2), then stream (§8.3).

**On octet-stream:** the server accepts only `application/pdf`.
- The client always sets that header itself, for any file it accepts: a `.pdf` name or `file.type === 'application/pdf'`. A browser that reports `''` or `application/octet-stream` for the file therefore doesn't matter.
- The server's real check is on content: the `%PDF-` magic bytes (`documentVault.js:246-248`).

### 8.2 Disk budget

The daily backup copies every vault document into each bundle with `fs.copyFile` (`server/services/backups.js:390-420`). Production keeps 14 bundles on `/data` (`fly.toml:22-25`). That volume also holds the SQLite database and the vault (`fly.toml:20-21`). So today each stored document costs about 15× its size. The volume is 4 GiB. A Fly snapshot on about 2026-10-28 stored 3.2 GiB, but actual usage hasn't been measured, so rollout step 1 measures it.

**Decision: hardlink vault documents into backup bundles instead of copying them. This ships first, as its own PR (PR A), before the tracker (PR B).** It changes backup behavior for every vault document, has its own failure mode, and must be revertible on its own. PR B's admission reserve depends on it.
- `copySecureDocuments` tries `fs.link(sourcePath, copiedPath)` first, and falls back to `fs.copyFile` on any `fs.link` error (for example `EXDEV`, `EPERM`, `ENOTSUP` or `EMLINK`).
- **A bad document must never delete database backups.** Every bundle now shares the live document's inode, so a bundle's document checksum (`backups.js:621-627`) effectively reads the live file. One damaged vault file would mark every bundle `invalid`, and `enforceBackupRetention` deletes invalid bundles, database snapshots included, after 24 hours (`:17`, `:478-485`). PR A therefore:
  - never auto-deletes a bundle whose database snapshot verifies;
  - reports a document checksum mismatch separately (`documentsDegraded`), rather than as an invalid bundle;
  - lets a new backup whose database verifies succeed, and report the document mismatch separately instead of failing verification (`:546-549`).
- *Why this is safe:*
  - vault files are written once (`documentVault.js:915`) and never edited in place;
  - deletion goes through trash staging, which unlinks only the vault's own name;
  - pruning a bundle (`backups.js:484-491`) unlinks only that bundle's name;
  - restore copies out of the bundle (`:801`);
  - the size and mtime checks (`:407-412`) still hold;
  - the `chmod 0600` (`:407`) lands on an inode that is already 0600.
- *What we give up:* 14 days of independent document copies become one shared copy. If a vault file is damaged in place, every bundle's copy is damaged too. Recovery then depends on Fly volume snapshots (14-day retention), which were also the only protection against losing the volume.
- *Effect:* a document then costs about 1×. This helps the existing broker upload path as well.
- *Cost if wrong:* if a link fails silently, backups fall back to copying, which is today's behavior.

**Decision: an admission reserve.** After writing the upload, the volume must still have at least `max(1 GiB, 2 × size of SQLITE_PATH)` free. That covers the next backup's full database copy. Otherwise the route returns `507 storage_full`.
- *Why:* SQLite running out of disk is the outage we can't afford. A refused upload is cheap.
- *Cost if wrong:* the owner is refused an upload while some headroom still remains.

We rejected the reviewer's alternatives:
- a vault-total cap, because it doesn't count backup copies or SQLite growth;
- a cap lower than 25 MiB, because real SIMs routinely exceed 8 MiB (the vault's default, `config.js:620`).

### 8.3 Streaming

- Bytes go through `stream.pipeline(request, check, fs.createWriteStream(finalPath, { flags: 'wx', mode: 0o600 }))`.
- The check transform:
  - counts bytes and aborts past `Content-Length` or 25 MiB, returning `413`;
  - verifies `%PDF-` on the first 5 bytes, returning `422 not_a_pdf`;
  - feeds a sha256 hash, which goes into the request digest.
- Memory stays at about one 64 KiB chunk per upload. Nothing is buffered whole.
- The directory is `storageDir/<syntheticRequestId>/` with mode 0700, and the file name is `<docId>-<safeName>` (as at `documentVault.js:848-856`).
- After the stream, the server checks that the byte count equals `Content-Length`.

### 8.4 Write path and cleanup

1. **Write-ahead cleanup job.** Persisted before the first byte is written, through `persistSecureDocumentCleanupJob` (`documentVault.js:880-909`), with:
   - `metadata = { reason: 'ambiguous-secure-upload-finalization', documentIds: [docId], reconcileAfter, writeAheadIntent: true }`, and **no `requestId`**;
   - `files = [{ documentId: docId, originalPath: finalPath, stagedPath, staged: false, purgeOriginalIfStagedMissing: true }]`.

   The reconciler keeps the file when the document row exists and purges it when the row doesn't (`submissions.js:1860-1875`). It resets a request only when `metadata.requestId` is present (`:2129-2141`). The synthetic request commits atomically with the document, so it must never be reset. Stored `storage_path` equals `originalPath`, as the reconciler checks.
2. **Stream** (§8.3). On any error, unlink the file and settle the job as `completed`.
3. **One transaction** inserts:
   - a synthetic `secure_upload_requests` row: `status completed`, `requested_documents [{category:'cim'}]`, `nda_required false`, `requested_by = actor`, email = the submission's email or the connected address, `expires_at = closed_at = now`. This row is needed because `secure_documents.request_id` is NOT NULL (`schema.sql:144`);
   - the `secure_documents` row with `document_type 'cim'`;
   - CRM activity `documents.uploaded` with role `admin`;
   - the `sim-intake` event.

   **Convergence must match on both adapters:**
   - **SQLite.** Extract the body of `insertSecureDocument` (`sqlite.js:9346-9358`) into one shared in-transaction helper. `insertSecureDocument` and `recordPursuitSimIntake` both call it inside their `.immediate()` transactions, so the logic isn't copied. The helper runs: `assertCrmSubmissionWritableInTransaction`, the insert, superseding current follow-up recommendations, and `cimTransitions.convergeCimTerminalAuthority({ submissionId, evaluateMaterialsState: true, evidenceType: 'materials', evidenceId: docId, actor, source: 'pursuit-sim-intake-transaction', observedAt, now })`.
   - **Postgres.** The RPC's inserts fire `trg_000_pursue_cim_terminal_upload` and `trg_000_pursue_cim_terminal_document` (`schema.sql:18824-18833`) in the same transaction. Postgres already supersedes current follow-up recommendations through its trigger (`schema.sql:2939-2942`), so the migration adds nothing for that. The parity test (§10) checks both adapters.
4. **Settle the job.**

**Decision: use a synthetic request instead of `createSecureUploadRequest`.** That function requires `submission.email`, mints a broker token, and sends an invite (`documentVault.js:556-633`).

### 8.5 Abuse

- Uploads are admin only.
- Files are served only as attachments, with `no-store` (`app.js:3013-3016`).
- No antivirus exists; the vault relies on an allow-list plus magic bytes (`documentVault.js:19-32`, `:245-283`). We accept this for files the owner takes from his own mailbox, and record it as a known gap.

## 9. Failure modes & concurrency

| Case | Result |
|---|---|
| A reply R2 is recorded while the owner clicks a reply type on R1 | The acknowledgement covers only R1, so R2 stays flagged. No error. |
| Double click or retry | Same key, so the request replays. |
| Two tabs move the stage | Predecessor check fails; the second tab gets a 409 and refreshes. |
| An upload and a stage move race | On SQLite, writes are serialized. On Postgres, `FOR UPDATE` on the opportunity serializes them. The upload never gets a 409. |
| Reply on a provider-ambiguous conversation | Shown, because the tracker reads Gmail rows regardless of `applied` (`pursueCimReplyPoller.js:18-22`). |
| Crash after the file write | The cleanup job purges the orphan file. |
| Client disconnects mid-stream | Pipeline error; the partial file is unlinked and the capacity slot released (`finish`/`close`, `app.js:665-672`). |
| Gmail disconnected | The link falls back to the configured sender address. If none, no link. |
| Opportunity merged (`status <> 'active'`) | Listed with "Merged into another listing". Writes return `409 opportunity_not_active`. |
| Pursued but no campaign yet | Listed at SIM requested with its release status. Upload returns `409 no_crm_record`. |

## 10. Testing

**Unit** (`node --test`, `test/pursuitTracker.test.js`). Cover:
- every row of §5.2, and the membership table in §5.1;
- forward-only evidence and a sticky Passed;
- owner moves backward;
- a reply processed late but carrying an earlier `message_at`;
- acknowledgement uses the maximum, not the latest event;
- a prospectus URL is ignored;
- the Gmail URL builder.

**Both adapters** (`test/pursuitTrackerStorage.test.js`, and `…Postgres.test.js` gated by `DEAL_HUNTER_POSTGRES_INTEGRATION=1`, as in `test/gmailSendStoragePostgres.test.js:13`). Cover:
- the immutability triggers;
- replay vs conflict;
- the predecessor rule when two writers race;
- an upload racing a stage move: both commit;
- a failure injected after the document insert leaves nothing behind;
- **convergence parity:** a SIM intake on an `active-follow-up` campaign ends in `materials-received`, with cancelled touches, on both adapters;
- a `reply-type` write leaves the campaign's `row_version` and `terminal_revision` unchanged;
- no new column can hold a body.

**No-send** (`pursueCimGmailEndToEnd.test.js` style). Reply, then reply type, then upload. Assert zero provider `send` calls.

**HTTP** (`test/httpPursuedDeals.test.js`). Cover:
- viewer read gets no thread or message ids; viewer write gets 401;
- an unauthenticated or over-capacity request is refused before any body byte is read;
- 411, 413 (both by header and by actual stream length), 415, 422 (a PNG renamed to `.pdf`), and 400 for a malformed `%E0%A4%A` name;
- 507 with `statfs` stubbed;
- a replay doesn't read the body;
- a mid-stream abort leaves no file.

**Backups** (`test/backups.test.js`). Cover:
- bundle documents share the vault file's inode;
- pruning a bundle keeps the vault file;
- restore works from linked bundles;
- the copy fallback on any `fs.link` error;
- with one vault document damaged in place, every bundle whose database verifies is kept (none is pruned as invalid), the mismatch is reported as `documentsDegraded`, and a new backup still succeeds.

These backup tests ship in PR A.

**UI** (Vitest: `test-ui/PursuedDeals.test.jsx`, plus additions to `AcquisitionInbox.test.jsx`). Cover:
- chips and counts;
- one-click reply type and Undo;
- SIM received opens the upload control;
- the Broker replies block;
- the 409 copy;
- read-only mode.

Run on Node 22, outside the Bash sandbox, because the UI suite hangs inside it.

## 11. Rollout

**Decision: no feature flag.**
- The tracker reads data and records owner clicks.
- Its only campaign effect, an upload stopping follow-ups, is existing behavior applied to new evidence.
- The inbox SQL is unchanged.
- *Cost if wrong:* rolling back is a revert and redeploy.

Steps:
1. **Disk check, before deploying.**
   - Run `fly ssh console -C "df -h /data"` and `du -sh /data/backups /data/secure-documents /data/uckele-group.sqlite`.
   - If free space is under 1.5 GiB, extend the volume first, for example `fly volumes extend <id> -s 8`.
   - Record the numbers in the PR.
2. **Merge and deploy PR A, then PR B.** After PR A, run one backup and confirm a vault file's link count (`stat -c %h`) is greater than 1. For PR B, SQLite creates the table at boot. Supabase applies `20261105120000_pursuing_tracker.sql` first.
3. **Controlled Gmail test** (`docs/runbooks/gmail-connect.md`).
   - Reply from the controlled address.
   - Confirm the Broker replies block appears.
   - Confirm **Open in Gmail** opens that thread with a second Google account signed in.
   - Pick a reply type.
   - Upload a test SIM.
   - Confirm the campaign shows `materials-received`, and that Gmail Sent holds nothing new.
4. **After the next 03:30 backup.**
   - Confirm `/data/backups` grew by about the size of the database, not the vault.
   - Confirm `stat -c %h` on a vault file is greater than 1.

## 12. Review focus: five likely real-world failure inputs

1. **The SIM file.** A 30 MB scan. A password-protected PDF, which passes because it is still `%PDF-`. A `.pdf` that is really a saved HTML page. A file name with `%` or emoji.
2. **A full disk.** Today's 15× backup multiplier, if the hardlink change regresses. A database growing toward the reserve. An upload arriving during the 03:30 backup.
3. **Reply timing.** A reply landing just after the owner opens the row. Old messages recorded late. Two replies acknowledged with one click.
4. **Decisions changing underneath.** Watch or Pass after Pursue. Restore, then a second Pursue. A deal delisted while under contract, which must still show in the Broker replies block.
5. **The Gmail link.** Two signed-in Google accounts. A thread in Trash, which `#all` excludes. A null thread id before the first send is accepted.
