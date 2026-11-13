# Connect Gmail and turn on Pursue email sending

This runbook is for the owner. It sets up the app to send Pursue emails (the first email
to a listing broker and the follow-ups) from your own Google Workspace Gmail, and to stop
a campaign when the broker replies.

Everything ships **off**. Nothing is sent until you finish every step below, in order.
The Operations page has an **Email sending** card. It shows what is still missing, in plain
sentences, until it says **Ready to send.**

You will need:

- a Google Workspace administrator login for the domain the sending address belongs to;
- the sending address itself (for example `mathew@uckelegroup.com`);
- access to the app's server settings (Fly secrets), or someone who can set them for you;
- about 30 minutes.

---

## Part A. Create the Google OAuth client (one time)

The app gets permission to send and read mail through an **Internal** OAuth client. Internal
means only people in your Workspace can use it, and Google does not need to review it.

1. Open <https://console.cloud.google.com> and sign in with your Workspace administrator account.
2. At the top left, open the project picker.
   - Pick an existing project for the company, or click **New project**.
   - Name it something like `Uckele Group app`, keep your organization selected, and click **Create**.
   - Make sure the new project is selected in the picker before you continue.
3. Turn on the Gmail API.
   1. In the left menu, open **APIs & Services → Library**.
   2. Search for **Gmail API** and open it.
   3. Click **Enable**.
4. Set up the consent screen. Google calls this area **Google Auth Platform** (older screens
   call it **OAuth consent screen**).
   1. In the left menu, open **APIs & Services → OAuth consent screen**, then click **Get started**.
   2. **App name:** `Uckele Group Deal Hunter`. **User support email:** your address. Click **Next**.
   3. **Audience:** choose **Internal**. Click **Next**.
      - If **Internal** is greyed out, you are not signed in with a Workspace account, or the
        project is not under your organization. Fix that before going on.
   4. **Contact information:** your address. Click **Next**, agree to the policy, and click **Create**.
5. Add the two permissions (scopes).
   1. Open **Data access** (older screens: **Scopes** on the consent screen page).
   2. Click **Add or remove scopes**.
   3. Under **Manually add scopes**, paste these two lines exactly, then click **Add to table**:

      ```
      https://www.googleapis.com/auth/gmail.send
      https://www.googleapis.com/auth/gmail.readonly
      ```

   4. Click **Update**, then **Save**.
   - `gmail.send` lets the app send the Pursue emails. `gmail.readonly` lets it see replies in
     those threads so it can stop follow-ups, and read your Gmail signature so the emails end
     with it. The app never deletes or changes your mail or your settings.
6. Create the client.
   1. Open **Clients** (older screens: **APIs & Services → Credentials → Create credentials →
      OAuth client ID**).
   2. Click **Create client**.
   3. **Application type:** **Web application**. **Name:** `Deal Hunter Gmail`.
   4. Under **Authorized redirect URIs**, click **Add URI** and enter your site address followed by
      the callback path. For the live site that is:

      ```
      https://www.uckelegroup.com/api/admin/deal-hunter/gmail/callback
      ```

      - The first part must be **exactly** the app's `PUBLIC_SITE_URL` setting: same `https`, same
        `www`, no trailing slash. If they differ by even one character, Google shows
        `redirect_uri_mismatch` when you click **Connect Gmail**.
   5. Click **Create**.
   6. Google shows the **Client ID** and **Client secret**. Copy both somewhere safe for the next part.
      - Treat the client secret like a password. Do not email it or paste it into chat.

## Part B. Set the server settings (one time)

1. Make an encryption key for the stored Gmail permission. On a Mac, open Terminal and run:

   ```
   openssl rand -base64 32
   ```

   Copy the line it prints. This key encrypts the Gmail permission the app stores. If you ever
   change it, you must click **Connect Gmail** again.
2. Set these settings on the server. On Fly, run this from the project folder, replacing each
   `...` with your value:

   ```
   fly secrets set \
     PUBLIC_SITE_URL=https://www.uckelegroup.com \
     GOOGLE_OAUTH_CLIENT_ID=... \
     GOOGLE_OAUTH_CLIENT_SECRET=... \
     DEAL_HUNTER_GMAIL_SENDER_ADDRESS=mathew@uckelegroup.com \
     DEAL_HUNTER_GMAIL_TOKEN_KEY=... \
     DEAL_HUNTER_SENDER_NAME="Mathew Uckele"
   ```

   What each one is:

   | Setting | What to put |
   | --- | --- |
   | `PUBLIC_SITE_URL` | The site address. It must match the start of the redirect URI from Part A, step 6. |
   | `GOOGLE_OAUTH_CLIENT_ID` | The Client ID from Part A. |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | The Client secret from Part A. |
   | `DEAL_HUNTER_GMAIL_SENDER_ADDRESS` | The only mailbox allowed to connect. Emails go out from this address. |
   | `DEAL_HUNTER_GMAIL_TOKEN_KEY` | The key from step 1. |
   | `DEAL_HUNTER_SENDER_NAME` | Your name, shown as the From name on Pursue emails. |

   - Pursue emails have no footer. They end with "Best," and your **Gmail signature**, which the
     app reads from Gmail (step 3). Title, phone and mailing address are not settings any more:
     put whatever you want brokers to see in your Gmail signature.
   - Sending stays paused, and **Approve wording** stays greyed out, until your name is set and
     your Gmail signature is loaded and not empty.
   - `DEAL_HUNTER_SENDER_TITLE` and `DEAL_HUNTER_SENDER_PHONE` are no longer used; you can remove
     them with `fly secrets unset`.
3. Leave these **off** for now. You turn them on in Part C, step 5 (the controlled test), and
   they stay on for step 6:

   | Setting | Value for now | What it does when `true` |
   | --- | --- | --- |
   | `DEAL_HUNTER_PURSUE_SENDER_ENABLED` | `false` | Runs the sender every 15 minutes: first emails, follow-ups, and closing campaigns at day 28. |
   | `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED` | `false` | Checks Gmail every 5 minutes for replies, and stops follow-ups when a broker replies. |
   | `DEAL_HUNTER_CIM_PROVIDER_ENABLED` | `false` | Lets any CIM email reach a mail provider at all. |
   | `DEAL_HUNTER_CIM_PROVIDER_PROFILE` | empty | Which sending setup to use: `controlled-mailbox-v1` for the test in step 5, then `production-gmail-v1` for real sending in step 6. |
   | `DEAL_HUNTER_CIM_MAILBOX_PROVIDER` | empty | Only for step 5: `gmail` sends the controlled test through your connected Gmail. |
   | `DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS` | empty | Only for step 5: the one test inbox the controlled test may email. |

---

## Part C. Rollout, in order

Do these one at a time. After each step, check the **Email sending** card in Operations
(**Admin → Operations**, or **Deal Hunter → Operations**).

### Upgrading an install that already sends (the Gmail signature release)

If Pursue sending was already set up before the release that ends emails with your Gmail
signature:
- If the app stores data in Supabase, apply
  `supabase/migrations/20261113120000_pursue_gmail_signature.sql` before starting the new
  version. On SQLite the table is created at start.
- After the deploy, **sending pauses**. The email versions changed (no footer, your Gmail
  signature instead), so the approved wording no longer matches. The card says the wording
  isn't approved, and the signature isn't loaded until Gmail is read.
- To resume:
  1. Check your Gmail signature (step 4.1).
  2. Click **Refresh from Gmail** (the sender also reads it at its next run while Gmail is
     connected).
  3. Read the preview and click **Approve wording** (step 4).
- Emails that were prepared before the deploy but never sent are prepared again with the new
  wording. They are never sent with the old footer.
- `DEAL_HUNTER_SENDER_TITLE` and `DEAL_HUNTER_SENDER_PHONE` are no longer used.

### 1. Deploy with everything off

1. Merge and deploy the release.
2. If the app stores data in Supabase, apply the migrations
   `supabase/migrations/20261103120000_gmail_send_runners.sql` and
   `supabase/migrations/20261113120000_pursue_gmail_signature.sql` before starting the new
   version. On the default SQLite setup, the app creates its tables when it starts.
3. Open Operations. The **Email sending** card should show Gmail **Not connected**, wording
   **Not approved yet**, contact rule **Off**, Live sending **Off**.

### 2. Create the OAuth client and set the settings

Follow Part A and Part B above. Restart or redeploy so the app picks up the new settings
(`fly secrets set` restarts the app for you).

### 3. Connect Gmail

1. In the **Email sending** card, click **Connect Gmail**.
2. Google asks you to choose an account. Choose the sending address.
3. Google lists the two permissions (send email, read email). Click **Allow**.
4. You come back to Deal Hunter → Operations with a message at the top of the card:
   - **Gmail is connected.** The card shows the address and the time of the last check, and
     **Gmail signature** shows "Loaded from Gmail" with the time it was read. If it says
     "Not loaded yet" or that the last refresh didn't work, click **Refresh from Gmail**.
   - **That Google account isn't the configured sending address.** You picked a different
     account. Click **Connect Gmail** again and pick the sending address.
   - **Google didn't grant permission to both send and read email.** Click **Connect Gmail**
     again and leave both boxes ticked.
   - **The Google sign-in expired or was already used.** Click **Connect Gmail** again. Finish
     within 10 minutes.
   - **Gmail couldn't be connected.** A setting from Part B is missing or wrong (most often the
     redirect URI or `PUBLIC_SITE_URL`). Check them and try again.

### 4. Choose your Gmail signature, approve the wording, then turn on the contact rule

1. Choose the signature the emails end with. In Gmail, open **Settings (gear) → See all
   settings → General → Signature**. Under **Signature defaults**, set **For new emails use** to
   the signature you want brokers to see, then click **Save Changes** at the bottom.
   - Gmail gives the app one signature for the sending address. Google doesn't document which
     of your named signatures that is, so always check it in the preview (next step).
   - The signature needs some text, such as your name. A signature that is only an image
     leaves the plain-text part of each email unsigned, so the card refuses it. An image's alt
     text counts as text.
   - Lists, indents and headings are kept. Positioning and background images are removed.
     Signatures over 64,000 characters can't be used.
   - Back in the card, click **Refresh from Gmail** under **Gmail signature**.
2. In the card, open **Preview the emails**. Read the first email and each follow-up. Each one
   shows the plain text and, below it, the email as brokers will see it, ending with "Best,"
   and your Gmail signature (logo and links included). There is no footer.
3. Click **Approve wording**, read the confirmation, and click **Approve wording** again.
   - The app reads your signature from Gmail again at the start of every sender run (every 15
     minutes), when you reconnect Gmail, and when you click **Refresh from Gmail**. If it
     changed, the card says the wording changed and sending pauses until you approve again.
     An email already prepared with the old signature is prepared again, never sent.
   - If Gmail can't be reached, the signature loaded earlier keeps being used and the card says
     the last refresh didn't work.
4. Click **Turn on contact rule** and confirm.
   - While it is on, the app may email a listing's broker once about that listing without
     asking you about each broker. Generic mailboxes (like `info@`), suppressed addresses and
     brokers already contacted about the listing are skipped.

### 5. Send one controlled test to yourself

This proves that a real email, a follow-up and a reply all work, through the real sender and
reply checks. While the controlled test setup is on, the app can email **only** your test inbox:
an email to any other address is refused before it reaches Gmail.

You need a test inbox you can read and reply from. Use a different address from the sending
address (a personal address works).

1. Set these settings (on Fly, with `fly secrets set`), replacing the address with your test inbox:

   ```
   fly secrets set \
     DEAL_HUNTER_CIM_PROVIDER_ENABLED=true \
     DEAL_HUNTER_CIM_PROVIDER_PROFILE=controlled-mailbox-v1 \
     DEAL_HUNTER_CIM_MAILBOX_PROVIDER=gmail \
     DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS=my-test-inbox@example.com \
     DEAL_HUNTER_PURSUE_SENDER_ENABLED=true \
     DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=true
   ```

   - Put exactly one address in `DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS`. With none, or more
     than one, nothing is sent.
   - Always set `DEAL_HUNTER_CIM_MAILBOX_PROVIDER=gmail` together with the profile. Without it,
     the profile selects an offline test harness that turns off the app's own email, and the app
     refuses to start.
   - The app restarts. Check that it came back (`fly status` shows the machine `started` and
     passing) before going on. The daily digest and admin sign-in emails keep going through Resend
     during the test; only broker email is confined to your test inbox.
2. Lift the central outreach pause, if it is on. In **Admin → Operations** (the **Operations**
   page in the left sidebar, not the Deal Hunter Operations view), jump to **Automation**. In the
   **CIM outreach** section, click **Resume all CIM outreach** and confirm. Leave **Resume
   automation only** alone.
   - While that pause is on, the **Email sending** card's readiness says **All CIM outreach is
     paused.** and nothing sends.
   - The `DEAL_HUNTER_CIM_OUTREACH_PAUSED` setting in `fly.toml` stays `true`. It keeps the
     older send paths shut and doesn't affect the Gmail sender. Because of it, the button still
     reads **Resume all CIM outreach** afterwards; that's expected. Check the **Email sending**
     card's readiness instead: it no longer lists the pause.
3. In the **Email sending** card, click **Turn on Live sending** and confirm.
   - The Live sending part says **Sending setup: controlled test (one allowed recipient)**.
   - Readiness should say **Ready to send.** If it doesn't, fix what it lists first. Right after
     the settings change it may say **Reply checking hasn't run recently**; that clears within
     5 minutes, once the first reply check has run.
4. Make a dedicated test listing whose **only** broker email is your test inbox.
   - Don't reuse a real listing. A listing's contacts are every broker email the app knows for
     it: from the Sheet, from the CRM, and any you type on the listing. A real listing that
     already has a broker email would then have two, and the contact rule only emails a listing
     with exactly one, so the first email would wait.
   1. Add one row to the SMB Deal Hunter Google Sheet (the Sheet the Deal Hunter Inbox is
      synced from) for a made-up business:
      - **Name:** `Uckele Test Listing (do not pursue)`.
      - **Listing URL:** any page of your own.
      - **State:** one of `CA`, `NV`, `AZ`, `NY`, `NJ` or `CT`. The app works out the listing's
        local time from its state; with no state, or another state, the first email waits.
        Leave **City** empty or use a city in that state.
      - **Broker Name:** your name. **Broker Email:** your test inbox, and no other email address
        anywhere in the row. Don't use a shared mailbox like `info@` or `sales@`.
   2. After the next Sheet sync, find the listing in the Deal Hunter Inbox and open it.
      While `DEAL_HUNTER_SHEET_SYNC_ENABLED` is off, new Sheet rows only arrive with the daily
      08:00 (Pacific) digest, so a row added after 08:00 shows up the next morning. Under
      **Broker & Seller**, your test inbox is the only broker email.
5. Click **Request SIM** on the test listing.
   - If **Request SIM** isn't offered, either a campaign is already running for this listing (its
     **Pursue CIM canary** card shows its status, and another request isn't needed) or the listing isn't ready yet
     (for example the sync hasn't picked it up). If it isn't ready, wait for the next sync and
     check again.
6. Wait for the first email.
   - The sender runs every 15 minutes, and sends only on weekdays between 08:00 and 17:00 in the
     listing's local time.
   - Check your test inbox: the email comes from the sending address and ends with "Best," and
     your Gmail signature, with no footer.
   - **Last runs** in the card shows `1 initial email`.
   - Check that your signature is stable. Note the card's **current version** under
     **Wording**, wait for the next two sender runs (about 30 minutes), and reload the card.
     - The current version must be unchanged, and the wording must still say approved.
     - If it changes on every run (for example, Gmail returns a different image address each
       time), sending would pause every run. Simplify the signature in Gmail (for example,
       remove the image), refresh, approve again, and repeat this check.
   - In Gmail, open the sent test email (in **Sent**), click **⋮ → Show original**, and note the
     **Message-ID** line. Check that **From** shows your name and the sending address.
   - **First email not arriving?** Open the test listing. Its **Pursue CIM canary** card shows
     the **Campaign state** and, after a dot, why it is waiting. For example:
     - `Waiting On Eligibility · Contact Permission Missing`, or the Inbox asking you to choose a
       broker email when you click Request SIM: the listing has more than one broker email. Go
       back to step 4 and make a listing with only your test inbox.
     - `Action Required · Timezone Missing` or `Timezone Ambiguous`: its State isn't exactly one
       of the six above.

     Also check the **Email sending** card's readiness and **Last runs** in Operations.
7. Wait for the follow-up.
   - It is due 2 business days later at 08:00 in the listing's local time. There is no way to
     bring it forward: just wait for it.
   - Check your test inbox: the follow-up arrives **in the same thread** as the first email.
8. Reply to that thread from your test inbox.
   - Within about 5 minutes, **Last runs** shows the reply check with `1 replies`, and the
     listing's campaign shows as responded.
   - No more follow-ups are sent. You can check again after the next follow-up's due date.
9. Finish the test and switch to real sending:
   1. Click **Turn off Live sending** and confirm.
   2. Change the sending setup to production and remove the test-only settings with the
      go-live script. From the project folder, run:

      ```
      bash scripts/go-live-production-gmail.sh
      ```

      - You need `fly auth login` done, and the server must be running a release that includes
        the script (it tells you if not). You can run `--check` any time to confirm both; while
        Live sending is still on it ends with **Stopped**, which is expected.
      - It first checks, on the server, that the app would start with the new settings and that
        Live sending is off. It also refuses if Fly holds secret changes that were staged but
        never applied, because the switch would apply those too. If anything is wrong, it stops
        and changes nothing. To run only that check, add `--check`.
      - Then it asks you to type `GO LIVE`, checks again, and sets
        `DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1` and removes
        `DEAL_HUNTER_CIM_MAILBOX_PROVIDER` and `DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS`. If the
        test listing Sheet was added as a second Sheet source (`DEAL_HUNTER_SHEET_CSV_URLS`), it
        removes that too, and the deal feed stays. To leave that setting alone, add
        `--keep-sheet-sources`. All the changes are applied together, so the app restarts once.
      - It waits for the app to come back and checks the switch landed. It never turns Live
        sending on.
      - It prints setting names and the sending setup's label, never a setting's value.
      - If applying the changes fails and the app doesn't come back, the script prints the one
        command that starts it again with broker email off
        (`fly secrets unset DEAL_HUNTER_CIM_PROVIDER_PROFILE`). Don't set the profile back to
        `controlled-mailbox-v1` on its own: the test-only settings are already gone, and the app
        won't start that way.

      Without the script, run these two commands **in this order** instead. Removing
      `DEAL_HUNTER_CIM_MAILBOX_PROVIDER` while the profile is still `controlled-mailbox-v1`
      stops the app from starting. If the test listing Sheet was added as a second Sheet source,
      also remove `DEAL_HUNTER_SHEET_CSV_URLS` in the second command; the deal feed in
      `DEAL_HUNTER_SHEET_CSV_URL` stays.

      ```
      fly secrets set DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1
      fly secrets unset DEAL_HUNTER_CIM_MAILBOX_PROVIDER DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS
      ```

   3. Leave `DEAL_HUNTER_PURSUE_SENDER_ENABLED` and `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED` on.
      With Live sending off, the sender sends nothing.

**If any check fails:** click **Turn off Live sending**, set
`DEAL_HUNTER_PURSUE_SENDER_ENABLED=false` and `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=false`,
and contact your engineer. Don't go on to step 6.

### 6. Turn on Live sending for real

1. Check that these settings are in place from step 5:

   ```
   DEAL_HUNTER_CIM_PROVIDER_ENABLED=true
   DEAL_HUNTER_CIM_PROVIDER_PROFILE=production-gmail-v1
   DEAL_HUNTER_PURSUE_SENDER_ENABLED=true
   DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=true
   ```

   `DEAL_HUNTER_CIM_MAILBOX_PROVIDER` and `DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS` must be unset.
2. In the **Email sending** card, click **Turn on Live sending** and confirm.
   - The card shows who turned it on and when.
   - The Live sending part says **Sending setup: production**.
3. The card's readiness should now say **Ready to send.** If it doesn't, it lists what is
   missing; fix those first.
4. **Last runs** shows a new sender line within 15 minutes, and a new reply-checks line within 5 minutes.
5. Automatic Pursue still decides which deals get emails. Move it from `shadow` to `canary` to
   `active` in the Deal Hunter Inbox on your own schedule. In `shadow` nothing is sent.

---

## Stopping and troubleshooting

- **To stop all Pursue sending right away:** click **Turn off Live sending** and confirm. It
  takes effect before the next send. Emails that were about to go out go back on schedule and
  wait. While `fly.toml` keeps `DEAL_HUNTER_CIM_OUTREACH_PAUSED="true"`, the Operations outreach
  button always reads **Resume all CIM outreach** and can't pause the Gmail sender, so use
  **Turn off Live sending**.
- **To stop checking replies too:** turn off Live sending first, then set
  `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=false`. Without reply checks a broker's reply could
  not stop a campaign, so follow-ups are held while reply checking is off or hasn't run in the
  last 30 minutes; first emails would still go out if Live sending stayed on.
- **To disconnect Gmail:** click **Disconnect** and confirm. Sending and reply checks stop until
  you connect again. You can also remove the app's access at
  <https://myaccount.google.com/permissions>; the card then says to reconnect.
- **"Live sending needs to be re-applied."** The switch was saved, but its sending permissions
  were not fully updated, for example after a brief database error. Nothing extra is sent in
  this state. Click **Try again** under Live sending. It re-applies the current setting. If it
  keeps failing, turn Live sending off and contact your engineer.
- **"The wording or your Gmail signature changed since the card loaded."** Your signature was
  read from Gmail again after the card opened. Read the preview again and approve.
- **"This setting changed since the card loaded."** Someone else (or another tab) changed it.
  The card reloads; check the new state and try again if you still want the change.

What each readiness sentence means:

| The card says | What to do |
| --- | --- |
| Gmail isn't connected. | Click **Connect Gmail** (step 3). |
| Google access was revoked or expired — reconnect Gmail. | Click **Reconnect Gmail**. This happens if access was removed at Google or the Workspace password policy reset it. |
| Couldn't reach Google just now; it will retry. | Nothing. It clears by itself once Google answers. |
| The connected mailbox isn't the configured sending address. | Click **Reconnect Gmail** and pick the sending address, or correct `DEAL_HUNTER_GMAIL_SENDER_ADDRESS`. |
| The email wording isn't approved. | Review the preview and click **Approve wording**. |
| The contact rule is off. | Click **Turn on contact rule**. |
| Live sending is off. | Click **Turn on Live sending** when you're ready. |
| Your Gmail signature hasn't been loaded yet. Refresh it from Gmail. | Click **Refresh from Gmail** under **Gmail signature** (Gmail must be connected). Then approve the wording. |
| Your Gmail signature is empty. Add one in Gmail, then refresh it from Gmail. | Set a signature in Gmail (step 4), click **Refresh from Gmail**, then approve the wording. |
| Your Gmail signature is only images, with no text. Add your name as text in Gmail, then refresh it from Gmail. | Add text (at least your name) to the Gmail signature, or alt text to the image, click **Refresh from Gmail**, then approve the wording. |
| Your name for the From line (DEAL_HUNTER_SENDER_NAME) is missing from settings. | Set `DEAL_HUNTER_SENDER_NAME` (Part B), then approve the wording. |
| The server isn't set to send through Gmail yet (see the Gmail setup runbook). | Set `DEAL_HUNTER_CIM_PROVIDER_ENABLED=true` and the sending setup (`DEAL_HUNTER_CIM_PROVIDER_PROFILE`) from step 5 or step 6. |
| Live sending needs to be re-applied — use Try again. | Click **Try again** under Live sending. |
| The sender is switched off in server settings. | Set `DEAL_HUNTER_PURSUE_SENDER_ENABLED=true` (step 5 or step 6). |
| Reply checking is switched off in server settings, so follow-ups are held. | Set `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=true`. Until then no follow-up is sent. |
| Reply checking hasn't run recently, so follow-ups are held. | Check **Last runs**: reply checks should run every 5 minutes. If the latest one failed, or Gmail needs reconnecting, fix that; follow-ups resume after the next successful check. If it keeps failing, contact your engineer. |
| All CIM outreach is paused. | Someone turned on **Pause all CIM outreach** in Operations. Turn it off there when you want sending to resume. |
