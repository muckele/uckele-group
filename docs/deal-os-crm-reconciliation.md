# Deal OS CRM reconciliation runbook

This workflow separates four counts that must never be treated as interchangeable:

1. Source rows in the uploaded CSV/XLSX export.
2. Accepted rows after schema validation.
3. Canonical records inside that export after exact duplicate collapse.
4. Canonical opportunities after cross-source identity resolution.

Every accepted row retains a bounded row mapping (`rowNumber`, source identity, listing identity, and canonical index). The original file and arbitrary columns are not retained.

## Safe operator workflow

1. Upload a fresh Deal OS export and confirm source, accepted, rejected, duplicate, and canonical counts.
2. Run **Build preview** in Deal Hunter. Previewing performs no CRM writes and sends no email or CIM requests.
3. Resolve every unmapped row and ambiguous identity. Execution remains blocked while either count is non-zero.
4. Review create, update, unchanged, tombstoned, actionable, sourced, and conflict counts.
5. Execute within 30 minutes of the preview. Expired previews are rejected server-side and must be regenerated.
6. Enter the exact generated confirmation phrase, such as `RECONCILE 261 CANONICAL`. The server re-reads storage and rejects any digest or expected-ID drift.
7. Inspect the durable run result. A completed-with-errors run must be reviewed item by item; never re-upload the file as an ad-hoc retry. Once the cause is understood, rebuild the preview and execute the same plan again: the run resumes and retries only its failed items, while items that already landed are left alone. A fully completed run is terminal and replays as a no-op.
8. Run `npm run crm:integrity:audit` and require a clean result before treating reconciliation as complete.

## Lifecycle and communications safety

- Listings that satisfy the versioned high-fit rule are written as actionable `review` records.
- Other valid listings are written as `sourced`, normal-priority records with completed follow-up state and no next action.
- `sourced` records are outside the communications allowlist, so reconciliation cannot send broker or seller messages.
- Deal Hunter owns only the workflow it assigns itself. Once an operator moves a record past `sourced` or `review`, later syncs refresh the listing facts but leave status, follow-up state, next action, and operator-added tags alone. A demotion from high fit back to `sourced` clears only the tags Deal Hunter set.
- Preview counts describe listing changes, not bookkeeping. First-seen, last-seen, and generated-note timestamps move on their own between review runs and do not by themselves make a record `update`; a re-run over unchanged listings reports `unchanged` and plans zero writes.
- A `crm-deleted` import claim is a tombstone. Reconciliation does not recreate it automatically.
- One canonical opportunity can own only one CRM submission and one CRM import claim. Database uniqueness and atomic linking enforce this in SQLite and Supabase.

## Scoring interpretation

`fitScore` measures acquisition-profile fit. `completenessScore` measures how much evidence the sources disclosed. Missing narrative evidence is recorded as unknown; it is not treated as proof that recurring revenue, recession resistance, or AI resistance is absent. Annual profit remains required for high-fit outreach.

Each CRM record stores the scoring rule version, completeness policy version, missing-evidence list, field-level source provenance, deterministic field conflicts, source records, and canonical identity aliases.

## Integrity audit

`npm run crm:integrity:audit` is read-only. It reports canonical ownership collisions, multiple primaries, direct-versus-metadata identity mismatches, visible company/source-name mismatches, active records attached to deletion tombstones, and missing direct ownership links. The command rejects `--apply`; repairs require a separately reviewed manifest and a verified backup.
