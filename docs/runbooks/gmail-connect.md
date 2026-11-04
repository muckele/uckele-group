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
     those threads so it can stop follow-ups. The app never deletes or changes your mail.
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
     DEAL_HUNTER_SENDER_NAME="Mathew Uckele" \
     DEAL_HUNTER_SENDER_TITLE="Owner" \
     DEAL_HUNTER_SENDER_PHONE="..." \
     DEAL_HUNTER_CIM_AUTOMATION_PHYSICAL_POSTAL_ADDRESS="..."
   ```

   What each one is:

   | Setting | What to put |
   | --- | --- |
   | `PUBLIC_SITE_URL` | The site address. It must match the start of the redirect URI from Part A, step 6. |
   | `GOOGLE_OAUTH_CLIENT_ID` | The Client ID from Part A. |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | The Client secret from Part A. |
   | `DEAL_HUNTER_GMAIL_SENDER_ADDRESS` | The only mailbox allowed to connect. Emails go out from this address. |
   | `DEAL_HUNTER_GMAIL_TOKEN_KEY` | The key from step 1. |
   | `DEAL_HUNTER_SENDER_NAME`, `DEAL_HUNTER_SENDER_TITLE`, `DEAL_HUNTER_SENDER_PHONE` | Your signature. |
   | `DEAL_HUNTER_CIM_AUTOMATION_PHYSICAL_POSTAL_ADDRESS` | The mailing address in the email footer. If it is not set, `EMAIL_BRAND_MAILING_ADDRESS` is used. |

   - Sending stays paused, and **Approve wording** stays greyed out, until the name, title,
     phone and mailing address are all set.
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

### 1. Deploy with everything off

1. Merge and deploy the release.
2. If the app stores data in Supabase, apply the migration
   `supabase/migrations/20261103120000_gmail_send_runners.sql` before starting the new version.
   On the default SQLite setup, the app creates its tables when it starts.
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
   - **Gmail is connected.** You're done with this step. The card shows the address and the
     time of the last check.
   - **That Google account isn't the configured sending address.** You picked a different
     account. Click **Connect Gmail** again and pick the sending address.
   - **Google didn't grant permission to both send and read email.** Click **Connect Gmail**
     again and leave both boxes ticked.
   - **The Google sign-in expired or was already used.** Click **Connect Gmail** again. Finish
     within 10 minutes.
   - **Gmail couldn't be connected.** A setting from Part B is missing or wrong (most often the
     redirect URI or `PUBLIC_SITE_URL`). Check them and try again.

### 4. Approve the wording, then turn on the contact rule

1. In the card, open **Preview the emails**. Read the first email and each follow-up.
2. Click **Approve wording**, read the confirmation, and click **Approve wording** again.
   - If you later change your signature settings, the card says the wording changed, and
     sending pauses until you approve again.
3. Click **Turn on contact rule** and confirm.
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
2. In the **Email sending** card, click **Turn on Live sending** and confirm.
   - The Live sending part says **Sending setup: controlled test (one allowed recipient)**.
   - Readiness should say **Ready to send.** If it doesn't, fix what it lists first.
3. Pick one test listing in the Deal Hunter Inbox. You can use a real listing you don't plan to
   pursue, or add one for the test.
   1. Open the listing.
   2. Under **Broker & Seller**, set **Broker email** to your test inbox and save it.
   3. Click **Request SIM**.
4. Wait for the first email.
   - The sender runs every 15 minutes, and sends only on weekdays between 08:00 and 17:00 in the
     listing's local time.
   - Check your test inbox: the email comes from the sending address, with your signature.
   - **Last runs** in the card shows `1 initial email`.
5. Wait for the follow-up.
   - It is due 2 business days later at 08:00 local time.
   - To avoid the wait, ask your engineer to move that follow-up's due time to now.
   - Check your test inbox: the follow-up arrives **in the same thread** as the first email.
6. Reply to that thread from your test inbox.
   - Within about 5 minutes, **Last runs** shows the reply check with `1 replies`, and the
     listing's campaign shows as responded.
   - No more follow-ups are sent. You can check again after the next follow-up's due date.
7. Finish the test and switch to real sending:
   1. Click **Turn off Live sending** and confirm.
   2. Change the sending setup to production and remove the test-only settings:

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
  wait. The **Pause all CIM outreach** switch in Operations also stops everything.
- **To stop checking replies too:** set `DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED=false`.
- **To disconnect Gmail:** click **Disconnect** and confirm. Sending and reply checks stop until
  you connect again. You can also remove the app's access at
  <https://myaccount.google.com/permissions>; the card then says to reconnect.
- **"Live sending needs to be re-applied."** The switch was saved, but its sending permissions
  were not fully updated, for example after a brief database error. Nothing extra is sent in
  this state. Click **Try again** under Live sending. It re-applies the current setting. If it
  keeps failing, turn Live sending off and contact your engineer.
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
| Your name, title, phone, or mailing address is missing from settings. | Set the signature settings from Part B, then approve the wording again. |
| The server isn't set to send through Gmail yet (see the Gmail setup runbook). | Set `DEAL_HUNTER_CIM_PROVIDER_ENABLED=true` and the sending setup (`DEAL_HUNTER_CIM_PROVIDER_PROFILE`) from step 5 or step 6. |
| Live sending needs to be re-applied — use Try again. | Click **Try again** under Live sending. |
