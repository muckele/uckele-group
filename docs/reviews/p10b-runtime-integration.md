# P10B runtime integration — offline scope

This change supplies the previously missing executable host/worker and isolated ingress path on PR76. It has been exercised with fake Fly and email boundaries and real local child processes/SQLite. It authorizes no image build, deployment, Machine start, provider request, email, live record, production change or merge. `productionReady=false` and all global automation/sending hard-offs remain mandatory.

The only runtime target is app `uckele-group-p10b`, Machine `0803730bd1d7e8`, region `ewr`, volume `vol_vwnkpex1k3yx9dnv` mounted at `/data`, one shared CPU/512 MiB, restart `no`, and service autostart false. The frozen sender remains `P10B Sender <sender@p10b-e2e.uckelegroup.com>` and eventual recipient remains `mathew@uckelegroup.com`.

## Executable integration and ordering

After separate future authority and fully frozen packet review, the entry point is:

```sh
node scripts/run-p10b-first-mailbox.js --packet <reviewed-packet.json> --evidence-prefix <retained-prefix>
```

Importing the modules contacts nothing. The command requires the exact clean source commit, a reviewed packet and an exclusive host reservation before starting. The concrete adapter uses the existing Fly CLI/SSH boundary; it never builds or updates an image and never forwards a Fly credential into the Machine. The immutable image contains its source head via the Docker build argument `P10B_SOURCE_HEAD`.

The host validates sole Machine identity, immutable image, resource/service/volume configuration, explicit hard-offs, public runtime digest and nonsecret staged-key metadata digest. `STORAGE_PROVIDER=sqlite` is mandatory. It sends one packet over bounded JSON-lines on authenticated SSH stdio to `scripts/run-p10b-qualification-worker.js`. The worker validates actual runtime/source and stable database inode/path identity; the host never copies or mounts the live database.

Preparation uses a fresh absent database/WAL/SHM path and retained one-start markers, requires zero preexisting business/provider history, and invokes the existing synthetic preparation authorities once. It performs zero provider calls. The worker closes its connection, asks the main listener to drain and close its cached SQLite handle, then writes and exports the preparation receipt. The host performs its one stop attempt and stopped-state readback before declaring preparation successful. Failed starts/markers/receipts are retained without overwrite or retry.

Qualification requires the actual retained preparation, actual alias/transmission/payload/review identities, one qualify-start marker and one worker marker. The existing injected executor performs one outbound POST, one sent-mail reconciliation GET, signed delivery/reply verification and one exact inbound-content GET. It closes durable authorization/capability authority and restores pause/hard-offs before closing its SQLite connection. A local `SIGUSR2` handoff drains the existing listener and closes its SQLite connection; a bound retained acknowledgment proves this before the worker exports a pre-stop candidate. PID1 stays alive awaiting the external host's stop. Only after stopped state and local control-process reaping are verified does the host promote the candidate into the expiring lifecycle artifact. Failure/timeout/uncertainty never promotes a candidate.

The ingress drain adds no external route or listener. Isolated HTTP admits only availability and, in the qualify phase, the existing signed webhook. Public/admin/contact/upload/analytics mutations and preparation-phase webhooks are unavailable. Isolated startup skips auth/document cleanup and every scheduler, including backups and inbound retries. Ordinary production paths remain unchanged.

## Replay, lateness, bounds and retention

A fixed host state directory `~/.uckele-group-p10b-host` is shared by executable invocations. Exclusive per-packet attempts prevent changing the evidence prefix to replay a packet. The exact-Machine active reservation rejects another process before any Machine mutation. Verified closure renames the active reservation into retained closed evidence; uncertainty or host crash retains the active reservation. Recovery never deletes this record automatically. An interrupted start is explicitly `startUncertain=true`, even if a later read reports stopped, because killing a local client cannot cancel an already-issued remote mutation.

The host's single stop promise arbitrates watchdog, callback, failures and graceful SIGINT/SIGTERM. It cancels/reaps local in-flight control commands and attempts stop once; uncertain stop/read/reap retains admission. The independent stop budget is at most30 seconds even if execution permission has already expired. Preparation reserves30 seconds for closure and30 for stop inside its five-minute window. Qualification uses the unextended manifest deadline/maximum runtime, reserves the same closure/stop budget and caps the total permission window at15 minutes. Conservative maximum spend must fit $0.90 before start, leaving $0.10 within the $1 cap for remaining control/read costs; price assumptions must be owner-reviewed and current.

SQLite admits only a signed delivery for the outbound provider identity or an exact owner reply to the prepared alias while durable qualification authority remains current. It atomically claims the sole inbound-content attempt. Replay, a new process/connection, failed content, unrelated messages, attachments, background retries and late asynchronous work cannot obtain another GET. Placeholder/event/terminal/content writes recheck authority in their SQLite transaction. Ordinary CRM delivery/request/follow-up mutation is skipped for isolated ingress. Fetched inbound identity/envelope is compared with the signed event. Complete inbound response bodies are time-bounded, aborted on expiry and capped at64 KiB; no attachment endpoint is read.

All records, markers and host receipts are retained. No schema migration, live deletion, production readiness promotion or automation unpause is added.

## Offline evidence and review

The inherited checkout and all its uncommitted code were preserved unchanged. The active implementation is a separate local checkout at `/Users/Matt/Documents/Codex/2026-10-09/task-2/uckele-group`; the original patch, untracked files and reports are retained under the sibling `evidence` directory.

The tests exercise actual worker processes and the concrete CLI adapter against a local fake executable, including fresh no-send preparation followed by qualification. They verify permission/listener/database closure before stop and artifact emission, exact sender, one POST, replay refusal, early failure, corrupt frames/candidate, timeout, cancelled/late start and SSH work, one-shot stop, unknown stop/reap, missing/duplicate/failed drain acknowledgments, fixed target, wrong inbound identity/alias/sender/attachments, failed/hung/oversized content and delayed post-closure writes. Local listener tests require sandbox permission to bind loopback; that is software-test evidence only.

Independent reviewer `/root/runtime_review` reproduced the original gaps and reviewed the corrections. Final exact-patch approval and test results are recorded in the implementation status report and PR. Historical readiness reports are not completion evidence for this integration.

## Remaining live gates and exact design decision

No approved live packet or image/database/team/configuration/price/permission digest is currently frozen. Separate approval must cover image build/push and stopped-image/configuration update, then a bounded no-send fresh preparation window. Keep the fresh path and actual prepared identities, payload, alias, image and receipt for a subsequent separately approved one-email window. No preparation approval automatically grants sending authority. The owner reply and actual provider lifecycle remain unperformed.

The unresolved live design is abrupt loss of the host supervisor (SIGKILL, host crash or connectivity loss). Graceful signals, channel failure and JavaScript hangs are covered; a dead host cannot execute its timer. Retained admission prevents replay but is not an infrastructure stop guarantee. Before live start, select and approve an independently available stop guardian with stop-only authority for this exact Machine and a shared one-shot stop latch; define its placement, absolute cutoff and receipt/uncertainty ownership. No new service, credential, resource or guardian deployment has been implemented or authorized by this offline change. This is the smallest remaining supervision decision, not a claim that killing the local Fly client cancels a remote start.
