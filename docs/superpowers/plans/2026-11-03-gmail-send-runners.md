# Gmail Send Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send Pursue CIM initial emails and follow-ups from the owner's Google Workspace mailbox, detect replies, and stop campaigns. Everything ships off and is proven end to end against a fake provider.

**Architecture:**
- A small provider interface (`cimMailProvider.js`) sits behind the existing CIM gates. It has a Gmail REST implementation and a fake one.
- A scheduled sender drives the existing Pursue storage transitions for initial emails and follow-ups.
- A reply poller turns Gmail thread changes into the existing inbound terminal events.
- Durable, audited controls gate readiness: the Gmail connection, wording approval, the contact rule and Live sending.

**Tech Stack:** Node 22 ESM, Express, better-sqlite3 + Supabase/Postgres (RPCs, `supabase/schema.sql` mirror), React 18 + Vite, `node --test`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-gmail-send-runners-design.md`

## Global Constraints

- **No new npm dependencies.**
  - Google OAuth and Gmail calls use global `fetch`, injected as `fetcher` everywhere so tests never reach the network.
  - Encryption uses `node:crypto` (AES-256-GCM).
- **SQLite and Supabase parity.**
  - Every new storage method exists in `server/storage/sqlite.js` (or `pursueCimSqliteTransitions.js`) and in `server/storage/supabase.js`.
  - Every DDL or RPC change goes into the new migration `supabase/migrations/20261103120000_gmail_send_runners.sql`, mirrored in `supabase/schema.sql`.
  - New tables are service-role only (RLS enabled, no anon/authenticated grants), like the existing `deal_hunter_cim_*` tables.
- **Default off.** These env vars default to `false`:
  - `DEAL_HUNTER_PURSUE_SENDER_ENABLED`
  - `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED`

  Live sending, the contact rule and wording approval all start off or unset. `fly.toml` is not changed.
- **Secrets never leak.** The refresh token, access token and client secret must never appear in any HTTP response, log line, audit payload, Job history row or error message. Tests assert this.
- **New env vars:**
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
  - `DEAL_HUNTER_GMAIL_SENDER_ADDRESS`
  - `DEAL_HUNTER_GMAIL_TOKEN_KEY` (32 bytes, base64)
  - `DEAL_HUNTER_SENDER_NAME`
  - `DEAL_HUNTER_SENDER_TITLE`
  - `DEAL_HUNTER_SENDER_PHONE`

  Add every one to `.env.example` with a comment.
- **Fixed values.** Use these exactly:
  - Gmail scopes: `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/gmail.readonly`.
  - Callback path: `/api/admin/deal-hunter/gmail/callback`.
  - Provider name: `gmail`.
  - Provider profile: `production-gmail-v1`.
  - Contact policy: `listing-broker-inquiry-v1`.
  - Template versions: `pursue-cim-initial-v1` and `pursue-cim-follow-up-v1`.
  - Payload versions: `deal-hunter-cim-pursue-initial-v2` and `deal-hunter-cim-pursue-follow-up-v1`.
  - Message-ID format: `<{transmissionId}@{sender domain}>`.
- **Readiness reason codes:** `gmail_not_connected`, `gmail_token_invalid`, `gmail_address_mismatch`, `wording_not_approved`, `contact_rule_off`, `live_sending_off`, `signature_incomplete`.
- **Copy** is exactly spec §8.2, including the footer.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Environment:**
  - Run `. "$HOME/.nvm/nvm.sh"; nvm use 22` first.
  - Vitest (`npm run test:ui`) and Playwright (`PLAYWRIGHT_PORT=4273 npm run test:browser`, after `npm run build`) need the sandbox off.
  - Gated Postgres runs with `DEAL_HUNTER_POSTGRES_INTEGRATION=1 node --test --test-concurrency=1 $(ls test/*Postgres*.test.js)` (Docker `postgres:16`, `--pull=never`).

## Review Focus

1. **The owner revokes access at Google.** The token refresh returns `invalid_grant`, so readiness reports `gmail_token_invalid`. Nothing is sent, no campaign changes state, and Operations shows Reconnect. Pinned in Task 3 and Task 6.
2. **A broker colleague or assistant replies in the thread from a different address.** It still counts as `responded`, because the match is on the thread and the sender isn't us. Pinned in Task 9.
3. **The process dies after the provider seam was entered but before finalize.** The next sender run reconciles through `findSent`, so there's no double send. Pinned in Task 8.
4. **A business name or broker name with non-ASCII characters, CR/LF or `<>`.** Headers are RFC 2047 encoded or stripped, so header injection is impossible. Pinned in Task 3.
5. **A DST change week.** A follow-up due at 08:00 local is still sent at 08:00 local wall time after the switch. Pinned in Task 8.

---

### Task 1: Storage foundations

**Files:**
- Create: `supabase/migrations/20261103120000_gmail_send_runners.sql`
- Modify: `supabase/schema.sql`, `server/storage/sqlite.js`, `server/storage/pursueCimSqliteTransitions.js:81-84` (`requiredProvider`), `server/storage/supabase.js`
- Test: `test/gmailSendStorage.test.js`, `test/gmailSendStoragePostgres.test.js` (gated by `DEAL_HUNTER_POSTGRES_INTEGRATION`)

**Interfaces:**
- Produces, as storage methods on both adapters:
  - `getGmailConnection() -> row|null`, the active (non-revoked) row.
  - `saveGmailConnection({ emailAddress, refreshTokenCiphertext, grantedScopes, historyCheckpoint, connectedBy, now }) -> row`. It revokes any prior active row in the same transaction.
  - `revokeGmailConnection({ revokedBy, now }) -> row|null`
  - `recordGmailTokenCheck({ ok, errorCode, now })`
  - `updateGmailHistoryCheckpoint({ expected, next, now }) -> boolean`, compare-and-set.
  - `getPursueSendControls() -> { liveSending, contactRule, wordingApproval }`. Each is `{ enabled, valueDigest, policyVersion, changedAt, changedBy, revision }`.
  - `setPursueSendControl({ controlKey, enabled, valueDigest, policyVersion, expectedRevision, actor, reason, now }) -> control`. It throws `send_control_conflict` when the revision is stale, and appends a `deal_hunter_cim_audit_events` row.
  - `setCimConversationGmailThread({ conversationId, gmailThreadId, now })`
  - `listOpenGmailConversations() -> [{ conversationId, gmailThreadId, campaignId, recipientFingerprint }]`
- Tables:
  - `deal_hunter_gmail_connections`, with the columns in spec §4.2.
  - `deal_hunter_pursue_send_controls`, keyed by `control_key` in (`live_sending`, `contact_rule`, `wording_approval`), with `enabled`, `value_digest`, `policy_version`, `changed_at`, `changed_by`, `revision`.
  - New column `deal_hunter_broker_conversations.gmail_thread_id text null`.
- The provider check accepts `('resend','gmail')` in SQLite `requiredProvider` and in every Postgres CHECK/RPC that pins `resend`: `20261005120000_pursue_cim_provider_outcomes.sql`:30, :208, :230 and `20261007120000`:131. These are redefined in the new migration.

- [ ] **Step 1: Write the failing SQLite storage tests.**
  - `gmail connection save replaces the prior active row`
  - `revoke clears the active connection`
  - `checkpoint compare-and-set rejects a stale expected value`
  - `send control set is revisioned, audited, and rejects a stale revision with send_control_conflict`
  - `provider outcome accepts gmail and still rejects unknown providers`
  - `open gmail conversations list excludes terminal conversations`
- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/gmailSendStorage.test.js`. Expected: FAIL (methods undefined).
- [ ] **Step 3: Implement the SQLite DDL and methods, then the migration, the `schema.sql` mirror and the Supabase methods (RPCs where the existing CIM methods use RPCs).**
- [ ] **Step 4: Write the gated Postgres test.** Fresh `schema.sql` plus an upgrade replay of all migrations. Cover the same assertions, plus: anon/authenticated cannot select the new tables, and a mirror check that the migration and `schema.sql` define identical functions.
- [ ] **Step 5: Run both.**
  - `node --test test/gmailSendStorage.test.js`: PASS.
  - The gated Postgres command on `test/gmailSendStoragePostgres.test.js`: PASS.
  - `npm test`: no regressions.
- [ ] **Step 6: Commit** `feat: storage for Gmail connection, send controls, and gmail provider outcomes`.

### Task 2: Token encryption and the Connect Gmail flow

**Files:**
- Create: `server/services/gmailTokenCrypto.js`, `server/services/gmailConnection.js`
- Modify: `server/config.js` (add `dealHunter.gmail = { clientId, clientSecret, senderAddress, tokenKey }`), `server/app.js` (3 routes), `.env.example`
- Test: `test/gmailConnection.test.js`, `test/httpGmailConnection.test.js`

**Interfaces:**
- Consumes: the Task 1 connection storage methods.
- Produces:
  - `encryptRefreshToken(plaintext, keyBase64) -> string` and `decryptRefreshToken(ciphertext, keyBase64) -> string`. The format is `v1.<iv b64>.<tag b64>.<ct b64>`. Decryption throws `gmail_token_key_invalid` on a bad key or a tampered value.
  - `buildGmailConnectUrl({ config, actor, now }) -> { url, state }`
  - `completeGmailConnect({ storage, config, code, state, actor, now, fetcher }) -> { emailAddress, connectedAt }`. It throws `gmail_state_invalid`, `gmail_address_mismatch` or `gmail_scope_missing`.
  - `disconnectGmail({ storage, config, actor, now, fetcher }) -> { revokedAt }`
  - `getGmailAccessToken({ storage, config, now, fetcher }) -> string`. It refreshes through `https://oauth2.googleapis.com/token`, calls `recordGmailTokenCheck`, and throws `gmail_token_invalid` on `invalid_grant`.
- Routes (admin role only; viewers get 403):
  - `GET /api/admin/deal-hunter/gmail/connect` returns a 302 to Google.
  - `GET /api/admin/deal-hunter/gmail/callback` returns a 302 to `/admin/deal-hunter?view=operations&gmail=connected`, or `gmail=<error code>`.
  - `POST /api/admin/deal-hunter/gmail/disconnect`
- `state` is HMAC-SHA256 over `{ nonce, actor, issuedAt }`, keyed by `tokenKey`. It is single-use: the nonce is stored in memory with a 10-minute TTL. That's acceptable because a restart only forces a re-click.

- [ ] **Step 1: Write the failing unit tests.**
  - `encrypt/decrypt round-trips and tampering throws gmail_token_key_invalid`
  - `connect URL requests offline access, consent prompt, both scopes, and the callback path`
  - `callback rejects reused, expired, and forged state with gmail_state_invalid`
  - `callback rejects a different mailbox with gmail_address_mismatch` (comparison is case-insensitive, so `Owner@Domain.com` matches)
  - `callback rejects missing gmail.readonly with gmail_scope_missing`
  - `callback stores ciphertext and the profile historyId, never plaintext`
  - `invalid_grant on refresh throws gmail_token_invalid and records the failed check`
  - `disconnect revokes at Google best-effort and still revokes locally when Google errors`
- [ ] **Step 2: Write the failing HTTP tests.**
  - `viewer cannot connect or disconnect (403)`
  - `no response body, header, or captured log line contains the refresh token, access token, or client secret` (spy on `console.*`)
- [ ] **Step 3: Run them and confirm they fail.** Run `node --test test/gmailConnection.test.js test/httpGmailConnection.test.js`.
- [ ] **Step 4: Implement, using the injected `fetcher` for every Google call.**
- [ ] **Step 5: Run them and confirm they pass.** Run `npm test` too.
- [ ] **Step 6: Commit** `feat: connect and disconnect the owner's Gmail with an encrypted refresh token`.

### Task 3: Provider interface, fake provider and Gmail provider

**Files:**
- Create: `server/services/cimMailProvider.js`, `server/services/gmailCimProvider.js`, `server/services/fakeCimProvider.js`, `server/services/rfc5322.js`
- Test: `test/gmailCimProvider.test.js`, `test/fakeCimProvider.test.js`

**Interfaces:**
- Consumes: `getGmailAccessToken` (Task 2).
- Produces the provider interface exactly as in spec §4.3, plus:
  - `assertCimMailProvider(provider)`, which throws if a method is missing.
  - `createGmailCimProvider({ storage, config, fetcher, now })`
  - `createFakeCimProvider({ now }) -> provider & { sent[], injectReply(threadId, message), failNext(outcome), quotaNext() }`
  - `buildRfc5322Message({ from, to, subject, text, html, messageId, inReplyTo, references }) -> string`, base64url-encoded by the caller.
- Outcome mapping (Gmail REST → `send` result):

| Gmail response | Result |
|---|---|
| 200 | `accepted`, with `messageId` and `threadId` |
| 400, 404, or 403 other than a quota reason | `definitive-failure`, `code=gmail_<status>` |
| 429, or 403 with reason in {`rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`} | `quota` |
| network error, timeout (30 s) or 5xx | `ambiguous` |

- `findSent` uses `GET users/me/messages?q=rfc822msgid:<id>&includeSpamTrash=false` and then `messages.get` for the `threadId`.
- `listThreadChanges` uses `users.history.list` with `startHistoryId` and `historyTypes=messageAdded`, filtered to `threadIds`. A 404 sets `checkpointExpired=true`. Messages are fetched with `format=metadata` and `metadataHeaders` = `From`, `Message-ID`, `In-Reply-To`, `References`, `Auto-Submitted`, `X-Autoreply`, `X-Autorespond`, `Precedence`, `Content-Type`. A `bodyPrefix` (the first 4096 chars of the decoded `text/plain` part, from `format=full`) is fetched only when the caller passes `withBodyPrefix: true`.
- `readiness()` reports `gmail_not_connected`, `gmail_address_mismatch` or `gmail_token_invalid`. Only the Gmail-level reasons come from here; Task 6 adds the rest.

- [ ] **Step 1: Write the failing tests** against canned responses, through the injected fetcher.
  - `send posts base64url raw with threadId for follow-ups and our Message-ID header`
  - `each status maps to the documented outcome`
  - `quota reasons map to quota, other 403 to definitive-failure`
  - `findSent finds by rfc822msgid and returns threadId`
  - `history 404 sets checkpointExpired`
  - `invalid_grant makes readiness report gmail_token_invalid and send returns definitive-failure without calling messages.send` (Review Focus 1)
  - `subject and display names with non-ASCII are RFC 2047 encoded; CR, LF, <, > in names or subject cannot add a header` (Review Focus 4)
  - `fake provider records sends, honors failNext/quotaNext, and returns injected replies from listThreadChanges`
- [ ] **Step 2: Run them and confirm they fail.** Run `node --test test/gmailCimProvider.test.js test/fakeCimProvider.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: Gmail and fake CIM mail providers behind one interface`.

### Task 4: Templates and the wording digest

**Files:**
- Create: `server/services/pursueCimTemplates.js`
- Modify: `server/config.js` (add `dealHunter.sender = { name, title, phone, postalAddress }`, where postal falls back to the existing `physicalPostalAddress` chain), `.env.example`
- Test: `test/pursueCimTemplates.test.js`

**Interfaces:**
- Produces:
  - `renderPursueCimEmail({ kind: 'initial'|'follow-up', followUpNumber?, isFinal?, deal: { name, brokerName }, sender, initialSubject? }) -> { subject, text, html, templateVersion, variant }`
  - `pursueCimFollowUpVariant(followUpNumber, isFinal) -> 'A'|'B'|'C'|'D'|'Final'`
  - `pursueCimWordingDigest(sender) -> sha256 hex`, computed over every template's text and version together with the sender signature fields. Per-deal values are excluded.
  - `senderSignatureComplete(sender) -> boolean`
  - `renderPursueCimWordingPreview(sender) -> [{ variant, subject, text }]`, using the sample deal `{ name: 'Sample Plumbing Co.', brokerName: 'Jordan Lee' }`.
- The copy is exactly spec §8.2.
  - `{greeting}` is `Hi <first word of brokerName>,` or `Hi there,`.
  - Follow-up subjects are `Re: ` plus the initial subject.
  - The footer goes on every email.

- [ ] **Step 1: Write the failing tests.**
  - `initial text equals the spec draft for the sample deal`. Store the expected text as a fixture string copied from spec §8.2.
  - `variants rotate A,B,C,D,A for numbers 1-5 and Final overrides`
  - `follow-up subject is Re: + initial subject`
  - `greeting falls back to Hi there, when brokerName is blank`
  - `digest changes when any template or signature field changes and not when the deal changes`
  - `senderSignatureComplete is false when name, title, phone, or postal is blank`
  - `html escapes business names`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: Pursue CIM email templates with a wording digest`.

### Task 5: Standing contact rule

**Files:**
- Modify: `server/services/pursueCimEnrollment.js` (around :150–:230, the activation check), `server/services/autoPursue.js` (the blocker that requires the permission activation, if any)
- Test: `test/pursueCimContactRule.test.js`

**Interfaces:**
- Consumes: `getPursueSendControls()` (Task 1).
- Produces:
  - `CONTACT_POLICY_VERSION = 'listing-broker-inquiry-v1'`
  - `contactRulePermits({ authority, recipient, controls }) -> { permitted, reason }`. The reasons are `contact_rule_off`, `contact_option_not_single`, `contact_source_not_allowed`, `generic_mailbox`, `recipient_suppressed` and `prior_outreach`.
  - `contactPolicyDigest(controls) -> hex`
- When the rule is on and `contactRulePermits` passes, `orchestratePursuitEnrollment` proceeds without a `fl04b-enrollment` activation. The campaign gets `permission_version='listing-broker-inquiry-v1'`, `permission_digest=contactPolicyDigest`, and `permission_revision` = the control revision. Otherwise the existing activation path is unchanged.

- [ ] **Step 1: Write the failing tests.** Use real SQLite storage and the existing enrollment fixtures from `test/pursueCimAutopilotService.test.js`.
  - One test per reason code.
  - `rule on + permitted recipient enrolls with listing-broker-inquiry-v1 and no activation`
  - `rule off falls back to waiting-on-eligibility contact_permission_missing exactly as before`
  - `a recipient who replied stop on an earlier listing is refused recipient_suppressed`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test` too.
- [ ] **Step 5: Commit** `feat: standing listing-broker contact rule for Pursue enrollment`.

### Task 6: Readiness, payload versions and Gmail dispatch through the gates

**Files:**
- Create: `server/services/pursueCimReadiness.js`
- Modify:
  - `server/services/pursueCimFinalGate.js`: `INITIAL_PAYLOAD_VERSION` handling at :29 and :290–:350. Accept `deal-hunter-cim-pursue-initial-v2` and `deal-hunter-cim-pursue-follow-up-v1` alongside `manual-stage1-v1`.
  - `server/services/pursueCimProvider.js`:
    - `sendAuthorizedCimTransmission` gains an optional `mailProvider`. When the provider profile's provider is `gmail`, it sends through `mailProvider.send`.
    - The result maps to `{ status: outcome==='accepted'?'sent':..., provider:'gmail', providerAttempted:true, providerSeamEntered:true, providerMessageId }`.
    - `quota` is returned as a distinct `errorCategory: 'provider_quota'` that the touch treats as not attempted.
    - The `reconcile` proof checks at :283, :316 and :379 also accept `gmail`, using `findSent`.
  - `server/config.js`: add the `production-gmail-v1` profile to `resolveCimProviderProfile`, and let the controlled-mailbox profiles name provider `gmail`.
  - `server/services/pursueCimInitialPreparation.js`: `proposal()` renders with `renderPursueCimEmail` and `payloadVersion: 'deal-hunter-cim-pursue-initial-v2'` when the Gmail profile is active.
- Test: `test/pursueCimReadiness.test.js`, plus additions to `test/pursueCimFinalGate.test.js` and `test/pursueCimProviderOutcomes.test.js`.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces `readPursueCimProviderReadiness({ storage, providerProfile, now, mailProvider, config })`. It returns the object `normalizeCimProviderReadiness` expects, with `ready` true only when every condition in spec §4.4 holds and `signatureComplete` is true. `reasons` uses the Global Constraints codes, in spec order.

- [ ] **Step 1: Write the failing tests.**
  - One readiness test per reason code.
  - `readiness is ready when all hold`
  - `final gate accepts both new payload versions and still rejects unknown`
  - `gmail accepted outcome finalizes the touch with provider gmail and stores gmail threadId on the conversation`
  - `quota leaves the touch scheduled and not attempted`
  - `the central pause still blocks with gmail ready`
  - `revoked token: final gate refuses with gmail_token_invalid and the campaign state is unchanged` (Review Focus 1)
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test` plus the gated Postgres suite.
- [ ] **Step 5: Commit** `feat: real readiness and Gmail dispatch through the CIM final gate`.

### Task 7: Listing due follow-ups and production follow-up preparation hooks

**Files:**
- Modify: `server/storage/pursueCimSqliteTransitions.js` (beside `listDueCimInitialTouches` at :3003), `server/storage/supabase.js` (beside :1333), the migration, `schema.sql`
- Create: `server/services/pursueCimFollowUpHooks.js`
- Test: `test/pursueCimDueFollowUps.test.js`, plus additions to `test/gmailSendStoragePostgres.test.js`

**Interfaces:**
- Produces:
  - `listDueCimFollowUpTouches({ now, limit = 25 }) -> [candidate]`. The candidate has the same shape as the initial candidates, plus `kind`, `ordinal`, `dueLocal` and `campaignExpiryAt`. It's backed by the RPC `pursue_cim_list_due_followup_touches_v1(p_now timestamptz, p_limit int)`, which returns only `scheduled` touches of non-initial kinds whose campaign is `active-follow-up`.
  - `loadPursueFollowUpAuthority({ candidate, storage, now })` and `buildPursueFollowUpPayload({ candidate, authority, storage, now })`, the production implementations for `runCimFollowUpPreparation`. The payload uses `renderPursueCimEmail` with `followUpNumber = ordinal` and `isFinal` = (`calculateNextCimSlot` lands at or after `campaignExpiryAt`). Its `payloadVersion` is `deal-hunter-cim-pursue-follow-up-v1`, and it carries `inReplyTo`/`references` from the initial transmission's Message-ID.

- [ ] **Step 1: Write the failing tests.**
  - `lists only due scheduled follow-up touches of active campaigns`
  - `excludes initial, claimed, cancelled, and terminal-campaign touches`
  - `payload marks the last follow-up before expiry as Final`
  - `payload threads to the initial Message-ID`
  - Postgres parity for the RPC.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat: list due Pursue follow-ups and build their payloads`.

### Task 8: Sender runner and scheduler

**Files:**
- Create: `server/services/pursueCimSender.js`, `server/services/pursueCimSenderScheduler.js`
- Modify:
  - `server/index.js`: start the scheduler.
  - `server/config.js`: `dealHunter.pursueSender = { enabled, intervalMinutes: 15 }`.
  - `server/services/dealHunterSheetSync.js`: after a successful sync, call `reevaluateWaitingPursuitEnrollments`.
- Test: `test/pursueCimSender.test.js`, `test/pursueCimSenderScheduler.test.js`

**Interfaces:**
- Consumes: Tasks 1–7, `runDueCimInitialPreparations`, `runCimFollowUpPreparation`, `issueCimLiveProviderAuthorization`, `authorizePreparedCimTransmission`, `finalizeAuthorizedCimTransmission`, `reconcileCimProviderTransmission`, `appendCimTerminalEvent`/`convergeCimTerminalAuthority`.
- Produces:
  - `runPursueCimSender({ storage, mailProvider, now, clock, config }) -> { sentInitial, sentFollowUps, expired, skipped: {reason: count}, failed, ambiguous, stoppedFor?: 'provider_quota'|'not_ready' }`
  - `sweepExpiredPursueCampaigns({ storage, now }) -> count`
  - `reevaluateWaitingPursuitEnrollments({ storage, now }) -> { enrolled, stillWaiting }`
  - `startPursueCimSenderScheduler({ storage, config, now, setTimer, clearTimer, run, logger, claimTokenFactory })`, following `startDealHunterSheetSyncScheduler`. The job name is `pursue-cim-sender`.
- Run order, which is fixed:
  1. Check readiness. If it isn't ready, return `stoppedFor:'not_ready'` and send nothing.
  2. Expiry sweep.
  3. Reconcile any transmission whose seam was entered but has no outcome, through `findSent` (Review Focus 3).
  4. Initial emails inside the send window (weekdays, 08:00–17:00 campaign local).
  5. Due follow-ups.

  Sends happen one at a time. On `quota`, stop and store a `provider_quota` marker for the local business day. Later runs that day skip with `provider_quota_wait`.
- Live sending: before each send, read `liveSending.enabled`. Only if it's true, call `issueCimLiveProviderAuthorization` for that one transmission, with actor `pursue-cim-sender`.
- Job history: one row per run carrying the counts, with no secrets and no email bodies.

- [ ] **Step 1: Write the failing tests.** Use real SQLite and the fake provider, with a controlled clock.
  - `not ready sends nothing and reports not_ready`
  - `live sending off sends nothing`
  - `initial outside 08:00-17:00 local or on a weekend waits; inside is sent and follow-up-1 is scheduled +2 business days at 08:00 local`
  - `follow-ups run every 2 business days and the last before day 28 uses Final`
  - `day-28 expiry sweep expires and cancels scheduled touches`
  - `quota stops the run, leaves the touch scheduled, skips the rest of the local day, resumes next business day`
  - `definitive failure moves the campaign to action-required`
  - `ambiguous + findSent found reconciles accepted with no resend; not found moves to provider-ambiguous with no resend`
  - `seam entered then crash: next run reconciles via findSent and does not send again` (Review Focus 3)
  - `DST: a follow-up straddling the November fallback is sent at 08:00 local wall time` (Review Focus 5)
  - `overlapping scheduler ticks run once (claim)`
  - `waiting enrollment becomes enrolled after the rule is turned on and a sync completes`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test` too.
- [ ] **Step 5: Commit** `feat: scheduled Pursue sender for initial emails, follow-ups, and expiry`.

### Task 9: Reply poller

**Files:**
- Create: `server/services/pursueCimReplyPoller.js`, `server/services/pursueCimReplyClassifier.js`
- Modify:
  - `server/storage/pursueCimSqliteTransitions.js` and the Supabase RPC: add evidence method `gmail-thread`, first in `methodOrder` at :501.
  - `server/services/pursueCimInbound.js`: accept the `owner_replied` terminal reason.
  - The migration and `schema.sql`: allow the `owner_replied` and `recipient_bounced` reason codes if a CHECK pins them.
  - `server/index.js` and `server/config.js`: `dealHunter.replyPoller = { enabled, intervalMinutes: 5 }`.
- Test: `test/pursueCimReplyClassifier.test.js`, `test/pursueCimReplyPoller.test.js`

**Interfaces:**
- Consumes: `listThreadChanges`, `listOpenGmailConversations`, `updateGmailHistoryCheckpoint`, `applyVerifiedPursueCimInbound`, and the existing suppression write used by inbound.
- Produces:
  - `classifyPursueCimReply({ message, connectedAddress, knownMessageIds }) -> 'ours'|'owner'|'bounce'|'auto-reply'|'stop'|'reply'`. The rules and precedence are exactly spec §6, step 4.
  - `runPursueCimReplyPoll({ storage, mailProvider, now }) -> { processed, responded, ownerReplied, bounced, autoReplies, stopped, checkpointExpired }`
  - `startPursueCimReplyPollerScheduler(...)`, with job name `pursue-cim-reply-poller`.
- The checkpoint advances only after every message has been applied. Processing is idempotent per Gmail message id.

- [ ] **Step 1: Write the failing classifier tests**, one per class and one per auto-reply header.
  - `stop words match whole words case-insensitively only within 4096 chars`
  - `"non-stop service" does not count as stop`
  - `a different sender address in the thread is reply` (Review Focus 2)
- [ ] **Step 2: Write the failing poller tests** with the fake provider.
  - `reply stops the campaign and cancels scheduled follow-ups`
  - `owner reply stops with owner_replied`
  - `auto-reply is logged and follow-ups continue`
  - `bounce moves to action-required recipient_bounced`
  - `stop suppresses the recipient for future listings`
  - `expired checkpoint falls back to per-thread reads and processes no message twice`
  - `crash before checkpoint save reprocesses without duplicate terminal events`
  - `no message body is persisted`
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them and confirm they pass.** Run `npm test` plus the gated Postgres suite.
- [ ] **Step 6: Commit** `feat: Gmail reply poller stops Pursue campaigns on replies`.

### Task 10: Operations "Email sending" card, API and runbook

**Files:**
- Create: `src/components/admin/EmailSendingCard.jsx`, `docs/runbooks/gmail-connect.md`
- Modify: `src/components/admin/OperationsCenter.jsx` (render the card), `server/app.js`
- Test: `test/httpPursueSendControls.test.js`, `test-ui/EmailSendingCard.test.jsx`, plus one Playwright flow in `test-browser/admin-phase16.spec.js`

**Interfaces:**
- Consumes: `getGmailConnection`, `getPursueSendControls`, `setPursueSendControl`, `readPursueCimProviderReadiness`, `renderPursueCimWordingPreview`, `pursueCimWordingDigest`, and the latest Job history rows for the two job names.
- Produces:
  - `GET /api/admin/deal-hunter/email-sending`, which returns `{ gmail: { connected, emailAddress, lastTokenOkAt, lastErrorCode }, wording: { approvedDigest, currentDigest, approvedAt, approvedBy, preview[] }, contactRule, liveSending, readiness: { ready, reasons[] }, lastRuns }`. Viewers get this without `preview`.
  - `POST /api/admin/deal-hunter/email-sending/controls` with body `{ controlKey, enabled, expectedRevision, reason }`. It is admin-only. For `wording_approval` with `enabled:true`, the server records the **current** digest itself and ignores any client-sent digest. A 409 means `send_control_conflict`.
- UI copy:
  - Card title: "Email sending".
  - Buttons: "Connect Gmail", "Disconnect", "Approve wording", "Turn on contact rule" / "Turn off contact rule", "Turn on Live sending" / "Turn off Live sending".
  - Each toggle opens a confirm dialog.
  - Readiness reasons render as plain sentences, one per code.
- The runbook gives click-by-click steps for an Internal OAuth client: the Google Cloud console, the OAuth consent screen set to Internal, the two scopes, the redirect URI, and the env vars. It then covers rollout steps 1–6 from spec §10.

- [ ] **Step 1: Write the failing HTTP tests.**
  - `viewer gets status without preview and cannot change controls`
  - `approve wording stores the server-computed digest`
  - `stale revision returns 409`
  - `response never contains token material`
- [ ] **Step 2: Write the failing UI tests.**
  - Renders the connected and not-connected states.
  - Readiness sentences.
  - The confirm dialog gates each toggle.
  - Approve wording is disabled while the signature is incomplete.
- [ ] **Step 3: Add the Playwright flow** `Email sending card shows readiness and gates Live sending behind confirmation`, using mocked routes like the existing phase16 fixtures.
- [ ] **Step 4: Run them and confirm they fail.**
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run them and confirm they pass.** Run `node --test test/httpPursueSendControls.test.js`, `npm run test:ui`, and `npm run build && PLAYWRIGHT_PORT=4273 npm run test:browser`.
- [ ] **Step 7: Commit** `feat: Operations Email sending card and Gmail setup runbook`.

### Task 11: End-to-end proof and full verification

**Files:**
- Create: `test/pursueCimGmailEndToEnd.test.js`, `test/pursueCimGmailEndToEndPostgres.test.js` (gated)

**Interfaces:**
- Consumes everything above, using the fake provider only.

- [ ] **Step 1: Write the end-to-end tests.** Each test drives real storage through the sender and poller ticks with a controlled clock:
  - `90+ deal → auto-Pursue active → initial sent in window → 2 follow-ups → broker reply → campaign responded, no more sends`
  - `75-89 deal → owner Request SIM → same loop to expiry at day 28 with ≤10 follow-ups and Final last`
  - `stop reply suppresses broker; a second listing from the same broker is refused recipient_suppressed`
  - `wording change after approval pauses sending until re-approved`
  - `Live sending off mid-campaign stops the next follow-up; on again resumes it`
- [ ] **Step 2: Run them.** SQLite: `node --test test/pursueCimGmailEndToEnd.test.js`. Postgres: the gated command. Expected: PASS. Fix anything they reveal in the owning task's files.
- [ ] **Step 3: Full verification.** Run `npm test`, `npm run lint`, `npm run build`, `npm run test:ui`, `PLAYWRIGHT_PORT=4273 npm run test:browser`, and the full gated Postgres suite. Also run `CRM_RESTORE_POSTGRES_INTEGRATION=1 node --test test/crmRestorePostgres.test.js` and `DEAL_HUNTER_PASSED_ARCHIVE_POSTGRES_INTEGRATION=1 node --test test/dealHunterPassedArchivePostgres.test.js`, because CI runs them. All must pass.
- [ ] **Step 4: Commit** `test: prove the Gmail Pursue loop end to end against the fake provider`.
