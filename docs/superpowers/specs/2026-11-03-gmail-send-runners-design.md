# Gmail Send Runners for Pursue CIM Campaigns — Design

**Date:** 2026-11-03
**Status:** Draft for owner review
**Builds on:** `2026-09-24-pursue-cim-autopilot-design.md`, `2026-11-02-best-first-deal-list-design.md`, `2026-11-02-mvp-send-readiness-design.md` (PRs #84, #85, merged)

## 1. Goal

Close the MVP loop. Deals scoring 90+ get a SIM request automatically, and deals scoring 75–89 get one after a single owner click. Follow-ups go out every 2 business days until day 28 and stop when the broker replies. All of these emails are sent one-to-one from the owner's own Google Workspace mailbox.

PRs #84 and #85 built ranking, the Request SIM decision, automatic Pursue, cadence v3, send timezones and the ownership guard. They stop at a campaign with a scheduled initial touch. This design adds:
- the Gmail provider;
- the send runners;
- reply detection;
- a standing contact rule;
- the email wording.

Everything ships switched off.

## 2. Owner decisions (2026-11-03)

| Decision | Choice |
|---|---|
| Send path (P8-00) | The owner's own Google Workspace mailbox, through the Gmail API. Resend is no longer used for broker email. |
| Mailbox type | Google Workspace on the owner's domain. The OAuth app is registered as **Internal**, so it needs no Google verification. |
| Connection approach | A one-click **Connect Gmail** button (OAuth). Not a service account, and not SMTP. |
| Contact basis | Listing brokers, one inquiry per listing, under the standing rule in §7. |
| Daily cap on initial emails | None. Google's own quota is the only limit (§5.6). |
| Replies | Any broker reply stops the campaign. The thread stays in the owner's Gmail for them to handle. |

## 3. Scope

**In scope:**
- the Gmail provider and the Connect / Disconnect flow;
- the provider interface and a fake provider;
- a real readiness check;
- the scheduled sender for initial emails and follow-ups;
- the Live sending switch;
- the day-28 expiry sweep;
- re-evaluation of waiting enrollments;
- the reply poller;
- the standing contact rule;
- versioned email wording with owner approval;
- an Operations "Email sending" card;
- the owner setup runbook.

**Out of scope:**
- parsing attachments (the owner marks materials received with the existing control);
- Gmail push notifications;
- moving non-broker email (for example the daily summary) off Resend;
- deploys, setting production env vars, connecting the real mailbox, and enabling any flag. These are owner actions (§10).

## 4. Gmail connection and provider interface

### 4.1 Owner setup (one time)

The owner creates an **Internal** OAuth client in their Google Workspace Cloud project. The redirect URI is `<APP_ORIGIN>/api/admin/deal-hunter/gmail/callback`. The scopes are `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/gmail.readonly`.

The owner then sets these server env vars:
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `DEAL_HUNTER_GMAIL_SENDER_ADDRESS`, the only address allowed to connect
- `DEAL_HUNTER_GMAIL_TOKEN_KEY`, a 32-byte base64 key used to encrypt the refresh token

`docs/runbooks/gmail-connect.md` gives the click-by-click steps.

### 4.2 Connect and Disconnect

Admin-only routes:
- `GET /api/admin/deal-hunter/gmail/connect` redirects to Google's consent screen with `access_type=offline`, `prompt=consent`, and a signed, single-use `state` that expires after 10 minutes.
- `GET /api/admin/deal-hunter/gmail/callback` does the following, in order:
  1. Verifies `state`.
  2. Exchanges the code for tokens.
  3. Reads `users.getProfile`.
  4. Refuses with `gmail_address_mismatch` unless `emailAddress` equals `DEAL_HUNTER_GMAIL_SENDER_ADDRESS` (compared case-insensitively).
  5. Refuses with `gmail_scope_missing` unless both scopes were granted.
  6. Stores the connection and records the starting `historyId` as the reply checkpoint.
- `POST /api/admin/deal-hunter/gmail/disconnect` revokes the token at Google (best effort) and marks the connection revoked.

The new table `deal_hunter_gmail_connections` holds a single active row. Columns:
- `id`, `email_address`
- `refresh_token_ciphertext` (AES-256-GCM, with IV and tag)
- `granted_scopes`
- `connected_at`, `connected_by`
- `revoked_at`, `revoked_by`
- `history_checkpoint`
- `last_token_ok_at`, `last_error_code`

The table is mirrored in `supabase/schema.sql` and a migration, with service-role-only access. The refresh token never reaches the browser, logs, audit payloads or error messages.

### 4.3 Provider interface

`server/services/cimMailProvider.js` defines:

```
{ name,
  readiness() -> { ready, reasons[] },
  send({ transmissionId, to, from, subject, text, html, threadId?, inReplyTo?, references? })
      -> { outcome: 'accepted'|'definitive-failure'|'ambiguous'|'quota', messageId?, threadId?, rfcMessageId, code },
  findSent({ rfcMessageId }) -> { found, messageId?, threadId? },
  listThreadChanges({ checkpoint, threadIds }) -> { messages[], nextCheckpoint, checkpointExpired } }
```

There are two implementations:
- **`gmailCimProvider.js`** calls Gmail REST and Google's token endpoint with `fetch`. No new dependencies.
  - Messages are built as RFC 5322 and sent with `users.messages.send`, plus `threadId` for follow-ups.
  - Every message carries our own `Message-ID: <{transmissionId}@{sender domain}>`, which is what makes sends idempotent (§5.7).
- **`fakeCimProvider.js`** is used by tests. It records sends, simulates outcomes, and lets tests inject replies.

The existing CIM gates stay in front of the provider unchanged:
- `enterCimProviderBoundary`
- the central pause
- the per-transmission live authorization
- the payload digest
- `enterCimProviderSeam`

`normalizeCimProviderOutcome` and the storage checks that pin the provider to `resend` change to allow `gmail`. That covers the SQLite `requiredProvider` and the Postgres checks in `20261005120000` and `20261007120000`, through a new migration. A new provider profile, `production-gmail-v1`, joins `resolveCimProviderProfile`, and the controlled-mailbox profiles accept `gmail` for the owner's test send.

### 4.4 Readiness

`readProviderReadiness` (the final gate's injected reader) becomes real. It returns `ready` only when all of the following hold:
- an active Gmail connection exists and its address matches the configured sender;
- a token refresh succeeded within the last 15 minutes, or succeeds now;
- the current wording digest is owner-approved (§8.3);
- the contact rule is on (§7);
- Live sending is on (§5.3).

Otherwise it returns the failing reasons: `gmail_not_connected`, `gmail_token_invalid`, `gmail_address_mismatch`, `wording_not_approved`, `contact_rule_off` or `live_sending_off`. Operations shows these reasons.

## 5. Send runners

### 5.1 Scheduler

`server/services/pursueCimSenderScheduler.js` follows the `dealHunterSheetSyncScheduler.js` pattern:
- It runs every 15 minutes.
- It claims the job with `claimScheduledJob`, so runs never overlap.
- It writes one Job history row per run with counts: sent, follow-ups sent, skipped (with reasons), failed, ambiguous.
- It is off unless `DEAL_HUNTER_PURSUE_SENDER_ENABLED=true`.

`runPursueCimSender({ storage, provider, now })` processes one email at a time, initial emails first and then follow-ups. Each email goes through these steps:
1. prepare;
2. issue the per-transmission authorization (§5.3);
3. run `authorizePreparedCimTransmission` (the final gate);
4. send;
5. finalize or reconcile.

### 5.2 Timing

- **Initial emails** go out when due, on weekdays between 08:00 and 17:00 in the campaign's send timezone (`target-state-v1` or the owner's choice). Outside that window they wait for the next window.
- **Follow-ups** follow cadence v3: the prior touch's accepted local date plus 2 business days, at 08:00 local. The sender sends any follow-up whose `due_at` has passed, provided it is still the same local business day. A follow-up missed by more than a day (for example after an outage) goes out on the next weekday morning and does not double up.

The new storage method `listDueCimFollowUpTouches({ now, limit })` has a SQLite version and the RPC `pursue_cim_list_due_followup_touches_v1`. It mirrors `listDueCimInitialTouches` and feeds `prepareReservedCimFollowUp` and `renewReservedCimFollowUp`.

The final gate accepts two new payload versions:
- `deal-hunter-cim-pursue-initial-v2`
- `deal-hunter-cim-pursue-follow-up-v1`

The `manual-stage1-v1` path is unchanged. The `buildPayload` / `loadAuthority` hooks that `runCimFollowUpPreparation` needs get production implementations.

### 5.3 Live sending switch

Today the P10B harness issues each send's one-time authorization by hand. Instead, the sender calls `issueCimLiveProviderAuthorization` itself, for one transmission at a time, but only while **Live sending** is on.

Live sending is a durable, audited setting with these fields:
- `enabled`
- `enabled_at`, `enabled_by`
- `disabled_at`, `disabled_by`
- `reason`

The owner turns it on and off in Operations. Turning it off takes effect before the next send. The central pause (`deal_hunter_cim_safety_settings.outreach_paused`) still overrides it, and so does the existing env pause.

Auto-Pursue modes are unchanged:
- `shadow` records decisions only;
- `canary` and `active` create campaigns that this sender sends.

### 5.4 Day-28 expiry sweep

Each run first moves to `expired` any campaign whose `local_expiry_at` has passed while it is still in `active-follow-up` or `initial-pending` with no terminal event. It goes through the existing terminal-event path, and every scheduled touch is cancelled.

### 5.5 Waiting enrollments

After each successful daily Sheet sync, enrollments in `waiting-on-eligibility` are evaluated again under the current contact rule and contact options. Any that now qualify go on to campaign creation.

### 5.6 Quota

A Gmail `429`, or a `403` with reason `rateLimitExceeded`, `userRateLimitExceeded` or `dailyLimitExceeded`, ends the run. The touch goes back to scheduled; it was never accepted, and Gmail rejected it before acceptance. The run records `provider_quota`. Further runs that local business day skip with `provider_quota_wait`, and sending resumes the next business day.

### 5.7 Failures never cause a double send

| What happened | Result |
|---|---|
| Gmail returns an id | `accepted`. The touch is finalized, the Gmail `threadId` is stored on the conversation, and the next touch is created. |
| Gmail returns a 4xx that isn't quota (bad recipient, invalid message) | `definitive-failure`. The campaign moves to `action-required` with the reason shown. |
| Timeout, 5xx, or a lost response | `ambiguous`. Before anything else, `findSent({ rfcMessageId })` searches the mailbox with `rfc822msgid:`. If found, the transmission is reconciled as accepted. If not found, the campaign moves to `provider-ambiguous` for the owner, and nothing is retried automatically. |

## 6. Reply detection

`server/services/pursueCimReplyPoller.js` runs every 5 minutes while Gmail is connected, under the same scheduler-claim pattern. It is off unless `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=true`.

1. It calls `users.history.list` from the stored checkpoint, with `historyTypes=messageAdded`, and keeps only messages in the thread IDs of open conversations.
2. If the checkpoint has expired (Gmail returns `404`), it falls back to `users.threads.get` for each open conversation's thread.
3. It fetches each message with `format=metadata`. For possible stop words it also reads the first 4 KB of the `text/plain` part, which is used for classification only and never stored.
4. It classifies the message, in this order:

| Message | Effect |
|---|---|
| Sent by us (its `Message-ID` matches a transmission) | Ignored |
| From the connected address, not a transmission | Terminal `owner_replied`: the owner has taken over and follow-ups stop. |
| Bounce: `mailer-daemon` sender, or `multipart/report; report-type=delivery-status` | `action-required`, `recipient_bounced` |
| Auto-reply: `Auto-Submitted` not `no`, `X-Autoreply`, `X-Autorespond`, or `Precedence: auto_reply/bulk/junk` | Logged as `auto_reply`. Follow-ups continue. |
| Contains a stop word (`stop`, `unsubscribe`, `remove me`, `do not contact`, case-insensitive, as whole words in the first 4 KB) | Terminal `responded` / `reply_received`, **and** the recipient is suppressed for all future listings, through the existing suppression path. |
| Any other message from someone else | Terminal `responded` / `reply_received` |

5. Evidence goes to `applyVerifiedPursueCimInbound` with a new evidence method, `gmail-thread`, which matches on the stored Gmail `threadId` together with the existing RFC `In-Reply-To` / `References` matching. Existing terminal convergence cancels scheduled touches.
6. Only after everything has been applied does it save the new checkpoint. The work is idempotent per Gmail message id, so a crash means reprocessing, not losing messages.

The poller stores only the classification, the Gmail ids, the `From` address fingerprint and a timestamp. It stores no message bodies.

## 7. Contact rule (`listing-broker-inquiry-v1`)

This is a standing, versioned policy the owner turns on in Operations. Turning it on or off is audited, with who did it, when, and the policy digest. While it is on, enrollment accepts a recipient without a per-recipient `fl04b-enrollment` activation when **all** of these hold:
- The recipient comes from one contact option of source `structured_source`, `crm` or `operator_verified`. This keeps the existing exactly-one-option requirement for automatic Pursue.
- It is not a generic mailbox. The existing `genericMailboxNames` list applies.
- It is not suppressed.
- There is no prior outreach to this recipient about this opportunity. This is one inquiry per listing.

The campaign records the policy as `permission_version = listing-broker-inquiry-v1`, along with the policy digest and the revision active at enrollment.

When the rule is off, the existing per-recipient path is unchanged and still works.

## 8. Wording

### 8.1 Templates

Templates live in `server/services/pursueCimTemplates.js`:
- the initial email is `pursue-cim-initial-v2`;
- the follow-ups are `pursue-cim-follow-up-v2`, with variants A, B, C, D and Final.

v2 (2026-11-05) replaces the v1 body copy with the owner's operator-voice wording. The subject, greeting, signature and footer are unchanged, so threading and reply classification are unaffected.

Follow-up *n* (n ≥ 1) uses variant `['A','B','C','D'][(n-1) % 4]`. The last follow-up uses **Final** instead. "Last" means `calculateNextCimSlot` would land at or after the campaign's expiry.

Follow-ups are sent in the same Gmail thread with the subject `Re: <initial subject>`.

The signature fields come from settings:
- `DEAL_HUNTER_SENDER_NAME`
- `DEAL_HUNTER_SENDER_TITLE`
- `DEAL_HUNTER_SENDER_PHONE`
- the existing `physicalPostalAddress`

The send is refused with the readiness reason `signature_incomplete` if any of these is blank.

### 8.2 Drafts for owner review

Placeholders: `{business}`, `{greeting}` (`Hi {broker first name},`, or `Hi there,` when there's no name), `{name}`, `{title}`, `{phone}`, `{postal}`.

**Initial.** Subject: `CIM / NDA request for {business}`

> {greeting}
>
> I'd like to evaluate {business}. Happy to sign your NDA. Could you send it over along with the CIM?
>
> What I'm buying: cash-flowing service businesses with $600K-$2M in SDE/EBITDA, recurring or repeat demand, and an established team. I focus on professional, healthcare, and tech-enabled services. I'm based in Southern California and open to strong opportunities nationwide.
>
> How I operate: as an active owner. I step in to learn the business and earn the trust of the team and customers, then build the systems and leadership so it runs well for the long term.
>
> Background: I co-founded and run Golden Behavior Connection, an ABA therapy company I've built since 2023, overseeing operations, staffing, compliance, revenue cycle, and financial performance. Before that I worked at Tripadvisor, Better Mortgage, and Wayfair.
>
> Ability to close: I'm aligned with an SBA 7(a) lender, have my equity ready, and can submit an LOI quickly once I've reviewed the financials. Proof of funds is available on request.
>
> Best,
> {name}
> {title}, Uckele Group
> {phone}

**Follow-up A**
> {greeting}
>
> Bumping this up. Still interested in {business}, and happy to sign the NDA today.

**Follow-up B**
> {greeting}
>
> Any update on {business}? My funding is in place, so I can give you a quick read once I see the CIM.

**Follow-up C**
> {greeting}
>
> If {business} is under LOI or the timing is off, just let me know and I'll stop following up.

**Follow-up D**
> {greeting}
>
> If someone else handles buyer inquiries for {business}, could you point me their way?

**Final**
> {greeting}
>
> Last note from me on {business}. If it comes back to market, I'd still like a look.

Every follow-up ends with the same signature as the initial email. Every email, initial and follow-up, ends with this footer:

> If you would rather I not reach out about future listings, just reply "stop".
> {postal}

### 8.3 Owner approval

The Operations card shows every template rendered for a sample deal, with an **Approve wording** button. Approval records the SHA-256 digest of the template set: the template text and the version, without the per-deal values. It also records who approved and when.

Readiness requires the current digest to equal the approved digest. Any change to the template text, or to the signature fields, produces a new digest and pauses sending (`wording_not_approved`) until the owner approves again.

## 9. Operations "Email sending" card

The card is admin-only; viewers see status only. It contains:
- **Gmail:** the connected address, or Connect; plus Disconnect and the last token check.
- **Wording:** the approved digest, the date and Approve wording, plus a preview.
- **Contact rule:** an on/off toggle with the policy version.
- **Live sending:** an on/off toggle, plus who turned it on and when.
- **Readiness:** ready, or the list of reasons.
- **Last runs:** the latest sender and reply-poller Job history lines.

Every toggle asks for confirmation and is audited.

## 10. Rollout (owner actions, in order)

1. Merge, deploy and apply the migrations. Everything arrives off.
2. Create the Internal OAuth client and set the env vars (§4.1), following `docs/runbooks/gmail-connect.md`.
3. Click **Connect Gmail**.
4. Click **Approve wording**, then turn on the contact rule.
5. Run a controlled test with the `controlled-mailbox-v1` profile and `gmail`, to one address the owner controls. Check that the initial email and a follow-up land in one thread, and that a reply stops the campaign.
6. Turn on Live sending and the sender and poller flags. Automatic Pursue goes `shadow` → `canary` → `active`, on the owner's schedule.

## 11. Testing

- **Fake-provider end-to-end tests** on SQLite and on gated Postgres:
  - initial email, then follow-ups every 2 business days, then a broker reply stops the campaign;
  - expiry at day 28 with no reply;
  - lost response: `findSent` finds the email and reconciles it as accepted, so nothing is resent;
  - lost response: `findSent` doesn't find it, so the campaign goes to `provider-ambiguous` and nothing is resent;
  - quota error, then a skip on the same day, then a resume the next business day;
  - an auto-reply doesn't stop the campaign;
  - a stop word stops the campaign and suppresses the recipient;
  - an owner reply stops the campaign with `owner_replied`;
  - a bounce moves the campaign to `action-required`;
  - changed wording means not ready, with nothing sent;
  - Live sending off means not ready, with nothing sent;
  - the central pause blocks sending;
  - the follow-up variant rotation and the Final selection;
  - the weekend and send-window rules.
- **Gmail adapter unit tests** against canned Google responses, through an injected `fetch`:
  - token refresh, send, threading headers, `rfc822msgid:` search;
  - history list, an expired checkpoint, quota codes.
- **Connect flow tests:**
  - state verification and expiry;
  - address mismatch and missing scope;
  - the token is never in the response or the logs;
  - Disconnect.
- **UI tests** (Vitest) for the Email sending card, and one Playwright flow.
- **Contact rule tests:** each condition, and that turning the rule off restores the per-recipient path.
