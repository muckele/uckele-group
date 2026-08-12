# Deal Hunter CIM identity incident — August 12, 2026

## Defensible incident statement

Twelve distinct Resend messages are confirmed delivered by retained provider IDs and signed webhooks. Each retained provider message ID has a signed `email.sent` event and a signed `email.delivered` event. An older request timestamp predates the first retained provider event, so this evidence does not establish that twelve were the only possible historical transmissions.

The twelve confirmed messages were three independent four-touch sequences: one initial CIM request and three follow-ups in each sequence. All three sequences were complete at investigation time and had no `next_follow_up_at`; the known live rows were not actively scheduled.

The root cause was a mutable opportunity identity. The source first supplied a listing without a URL, which produced a fingerprint `deal_key`. The same listing later gained a BizBuySell URL and produced a URL-based key. The system did not retain the fingerprint as an alias of the URL opportunity, so it treated the later representation as new and allowed another sequence. A credential-free reproduction reached the private send preparation path before the fix, proving the defect was latent even though the known live rows were complete.

Another similar listing had the same generic title, revenue, and broker but a different provider listing ID, geography, asking price, and profit. It is materially distinct and must remain separate. Neither title, subject, nor broker address is sufficient identity evidence.

The CRM screenshot amplified the apparent count: one accepted message normally produced a local `email.sent`, a signed Resend `email.sent`, and a signed Resend `email.delivered` activity. Twenty-one raw rows in the example represented seven distinct provider message IDs. Raw events remain durable; the admin projection now renders one logical lifecycle item per communication/provider message with the raw events available in an expandable audit trail.

Provider retrieval could not supply a second lookup because the production Resend key is correctly send-only and a restricted key returns `401` for email retrieval. The fix does not broaden that key.

## Containment and durable controls

- `DEAL_HUNTER_CIM_OUTREACH_PAUSED` and the Operations pause control block every initial and follow-up path while leaving review, inbound webhooks, and reconciliation available.
- An immutable canonical `opportunity_id` owns historical deal-key, URL, provider-listing-ID, trusted source-ID, and conservative fingerprint aliases.
- Exact/high-confidence fingerprint-to-URL transitions link automatically. Material conflicts stay distinct. Ambiguous evidence creates a full-admin review exception and blocks outreach.
- Initial sends and follow-ups repeat canonical identity, prior-sequence, source/snapshot, archive, suppression, recipient-cap, claim, and pause checks at the server boundary.
- Recipient caps count accepted logical initials and follow-ups, not raw lifecycle rows. The defaults in `.env.example` are examples and require release-owner review before production configuration.
- CIM follow-ups are restricted to the configured local weekday/business-hours window. `next_follow_up_at` is the earliest eligible time, not a guaranteed delivery time.

## Audit and repair commands

Dry run is read-only and prints bounded, recipient-redacted evidence:

```bash
npm run cim:identity:audit
```

The audit reports missing historical `opportunity_id` links separately and includes deterministically repairable links in the linkage-mismatch total. Apply refuses to proceed while any ambiguous historical pair lacks an explicit incident-owner decision. Put reviewed decisions in a protected JSON file; never commit a production decision file containing real record identifiers:

```json
{
  "decisions": [
    {
      "action": "link",
      "requestId": "reviewed-legacy-request-id",
      "targetRequestId": "reviewed-matching-request-id",
      "incidentOwnerAuthorized": true,
      "authorizedBy": "incident-owner",
      "reason": "Specific bounded evidence supporting this historical link."
    }
  ]
}
```

Use `"action": "keep-distinct"` when the incident owner deliberately decides that an otherwise ambiguous pair represents separate opportunities. Preview the effect before apply:

```bash
npm run cim:identity:audit -- --resolutions /absolute/path/to/protected-resolutions.json
```

For SQLite, create and verify an application-consistent backup before any authorized repair:

```bash
npm run backup:create
npm run backup:verify -- --bundle /absolute/path/to/backup-bundle
```

Apply is never run at application startup. It requires the explicit flag, exact confirmation, accountable actor, healthy storage, and a backup that the command verifies itself:

```bash
npm run cim:identity:repair -- \
  --confirm APPLY-CIM-IDENTITY-REPAIR \
  --actor release-owner \
  --resolutions /absolute/path/to/protected-resolutions.json \
  --backup /absolute/path/to/verified-backup-bundle
```

The apply transaction creates canonical records and aliases, backfills deterministic and explicitly reviewed historical links, quarantines duplicate active sequences, adds repair activities where a CRM submission exists, and stores the authorization evidence in a checksummed reconciliation manifest. It never guesses an unresolved ambiguous pair and never deletes requests, communications, message bodies, provider IDs, webhook events, or CRM submissions. Re-running the same plan returns the existing manifest without additional changes.

Supabase apply requires independently verified managed-backup evidence and an authorized operator procedure; the bundled CLI verifier applies only to SQLite backup bundles. Do not fabricate a local path as Supabase backup evidence.

## Rollout

1. Take and verify a production backup.
2. Enable the central CIM outreach pause before migration or repair.
3. Deploy code with outreach still paused.
4. Apply the additive storage migration. Supabase uses `20260812130000_cim_canonical_identity_safety.sql`; SQLite migrates additively at startup.
5. Verify `/api/ready`, storage health, identity storage health, inbound processing, and the Operations panel.
6. Run `npm run cim:identity:audit` without `--apply`.
7. Review exact/high-confidence groups, materially distinct groups, ambiguous exceptions, duplicate sequences, recipient cap excesses, linkage mismatches, and logical-versus-raw lifecycle counts.
8. Run apply only after explicit incident-owner authorization, using a verified backup and named actor.
9. Run the dry run again. Require zero unsafe duplicate active sequences and zero safely repairable linkage mismatches; review every remaining ambiguous exception manually.
10. With provider calls disabled or restricted to an approved internal test, verify the current source review, approval queue labels, timeline grouping, recipient caps, and send-window behavior.
11. Unpause only after a release owner accepts the audit and readiness state.
12. Monitor identity exceptions, cap blocks, duplicate sequence counts, complaints, bounces, replies, and logical send volume.

## Rollback and compensating repair

Immediately pause all CIM outreach. Keep inbound webhook processing active. Do not delete requests, communications, or provider events, and do not retry an ambiguous provider outcome under a new idempotency identity. Preserve the reconciliation manifest and its original backup reference.

If database restoration is required, use the existing verified recovery procedure and stop the application first. A relationship-only rollback should use the manifest’s recorded before identifiers to create an audited compensating repair; it must not delete newly retained lifecycle evidence. Restore a whole database only when the incident owner accepts that all intervening production changes will be handled under the recovery plan.
