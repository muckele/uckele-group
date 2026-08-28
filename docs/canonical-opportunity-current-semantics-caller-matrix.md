# Canonical Opportunity Caller Matrix

**Classification rule:** `HISTORICAL` may return preserved superseded rows. `CURRENT-ACTIVE` requires exactly `status = 'active'`. `MIXED` reads history for audit/context but separately requires current authority before any new action.

| Surface or caller | Classification | Implemented boundary |
| --- | --- | --- |
| `getDealHunterOpportunity` | HISTORICAL | Returns the stored canonical row regardless of active/superseded status. |
| `listDealHunterOpportunities` | HISTORICAL | Lists preserved canonical history; used by audits and repair inspection. |
| `findDealHunterOpportunityByAliases` | HISTORICAL | Enumerates the complete distinct owner set for every supplied alias, separately verifies every owner row exists, and returns one valid historical owner only. Multiple owners or a dangling owner fail closed. |
| `getCurrentDealHunterOpportunity` | CURRENT-ACTIVE | SQLite SQL and Supabase query require exact `status = 'active'`. |
| `listCurrentDealHunterOpportunities` | CURRENT-ACTIVE | Both providers filter exact active status before returning choices/candidates. |
| `findCurrentDealHunterOpportunityByAliases` | CURRENT-ACTIVE | Evaluates every matching alias row without a raw-row bound (chunked distinct-owner enumeration in SQLite, deterministic complete paging in Supabase), separately verifies every owner exists, returns one active owner, and distinguishes multiple-owner, missing-owner, and sole non-active failures. |
| `resolveDealHunterOpportunity` exact-alias path | CURRENT-ACTIVE | Uses current alias lookup; non-current alias becomes `non-current-canonical-alias` exception with no creation/resurrection. |
| `resolveDealHunterOpportunity` semantic enumeration | CURRENT-ACTIVE | Loads current list and filters caller-supplied candidates to exact active status. |
| Resolver alias-conflict recovery | CURRENT-ACTIVE | Conflict owner is accepted only through current getter. |
| Ordinary opportunity observation upsert | MIXED | May create/update active rows, but both providers atomically preserve an existing non-active row without changing status, metadata, or timestamps; this closes lookup-to-write resurrection races. |
| Automatic new-opportunity resolution | CURRENT-ACTIVE | One immediate SQLite transaction or one service-role Supabase RPC locks/acquires the stable alias set, returns an existing current owner or creates the opportunity plus aliases atomically, and cannot leave a losing active aliasless proposal. |
| Deal Hunter canonical identity attachment | CURRENT-ACTIVE | Preloads only current opportunities for ordinary acquisition review. |
| `resolveCimIdentityException` explicit target | MIXED | Historical lookup distinguishes superseded from missing; current lookup is mandatory before aliases/exception mutate. `mergedInto` is context only. |
| `resolveCimIdentityException` keep-distinct | CURRENT-ACTIVE | Opportunity creation, alias acquisition, and pristine-open exception resolution are one SQLite transaction or one Supabase RPC. A concurrent loser receives a 409 while its proposed opportunity is never inserted; an unusable/empty alias set is refused before mutation. |
| SQLite alias upsert/batch link | CURRENT-ACTIVE | Immediate transaction checks active target before any alias mutation. |
| Supabase alias upsert/batch link RPC | CURRENT-ACTIVE | Existing `link_deal_hunter_opportunity_aliases(jsonb)` signature locks active target atomically. |
| CIM identity repair audit | HISTORICAL | Continues to enumerate all opportunities and historical relationships for repair/audit. |
| Merge inspection, planning, replay, and final-state audit | HISTORICAL | Must see both survivor and preserved loser plus typed manifest and historical exception. |
| Merge post-apply resolver regression | MIXED | Historical lookup proves loser retained; normal resolver proves all approved aliases resolve only to active survivor. |
| Identity operations canonical count | CURRENT-ACTIVE | Counts current opportunities, while request/communication/audit histories remain historical. |
| Manual CRM creation with canonical ID | MIXED | Current lookup selects 409 versus unknown-ID error, then SQLite or the dedicated Supabase insert RPC locks and revalidates exact active status in the submission-and-activity transaction. |
| CRM preflight (`findExistingDealHunterSubmission`) | CURRENT-ACTIVE | A superseded opportunity's historical primary submission is not current authority. |
| Deal Hunter CRM field synchronization | CURRENT-ACTIVE | Requires the atomic link primitive, reloads the link-advanced submission/version, then applies ordinary fields with compare-and-swap; generic CRM updates cannot assign `deal_hunter_opportunity_id`. |
| CRM link/reconciliation | CURRENT-ACTIVE | SQLite transaction and unchanged Supabase RPC signature atomically lock/reject non-active ID. |
| CRM integrity audit | HISTORICAL | Uses all canonical rows/imports/submissions to find retained linkage and tombstone problems. |
| Manual CIM recipient override service | MIXED | Historical lookup explains refusal; current lookup required before write. No redirect. |
| Recipient override persistence | CURRENT-ACTIVE | SQLite transaction and new service-role Supabase RPC revalidate active target, reject cross-owner ID collisions, and make conflict updates owner-preserving. |
| Active recipient override lookup | CURRENT-ACTIVE | Joins current canonical status; a preserved stale override cannot grant authority. |
| Opportunity claim creation | CURRENT-ACTIVE | SQLite transaction and unchanged Supabase RPC atomically return `opportunity-not-current`. |
| Recipient claim creation | CURRENT-ACTIVE | SQLite transaction and unchanged Supabase RPC atomically return `opportunity-not-current`. |
| Claim getters and request/communication history | HISTORICAL | Existing claims and CIM history remain readable after supersession. |
| Stage 2 known-opportunity evidence | CURRENT-ACTIVE | Storage evidence list includes only active opportunity IDs. |
| Stage 2 deal-key alias evidence | CURRENT-ACTIVE | Alias list is joined to active canonical rows and rechecked against current IDs. |
| Stage 2 human review/metrics history | MIXED | Reviews remain readable. A nonblank stored canonical ID is authoritative provenance: active IDs qualify, while superseded or missing IDs are unlinked and never rebound through `deal_key`, moved aliases, or `mergedInto`. Deal-key fallback exists only for truly legacy reviews with no explicit ID. |
| Stage 2 decisions/runs/activations | HISTORICAL | Existing decision and rollout history remains readable. |
| Stage 2 final send authorization | CURRENT-ACTIVE | Independently revalidates matching active canonical row at the final boundary. |
| Historical score getter/evidence/fingerprint audit | HISTORICAL | Score rows and evidence survive supersession unchanged. |
| Machine score write | CURRENT-ACTIVE | SQLite transaction and unchanged Supabase score-write RPC lock/reject non-active opportunity. |
| Current score getter/detail | CURRENT-ACTIVE | Requires eligibility plus an active canonical inner join. |
| Current triage list/count/pagination | CURRENT-ACTIVE | SQLite query and Supabase list RPC join/filter active status before count, sort, and page. |
| Current eligibility reconciliation | CURRENT-ACTIVE | Supplied IDs are intersected with locked active rows; superseded scores are deactivated, never reactivated. |
| Triage operator decision | CURRENT-ACTIVE | Current score preflight plus atomic SQLite/new Supabase RPC active check. |
| Rescore/triage CRM activity attachment | CURRENT-ACTIVE | Uses current canonical lookup before adding new activity to a linked submission. |
| Historical CRM/CIM/communications/activities/email events/manifests/audit | HISTORICAL | No global filtering, deletion, rewriting, or generic reparenting was introduced. |

## Supabase atomic parity

The function-only migration preserves existing signatures for generic CRM activity mutation, alias linking, CRM linking, both canonical claim functions, score write, eligibility reconciliation, and paginated score listing. It adds five narrow service-role functions for operations that previously lacked an atomic current-aware RPC: submission-and-activity insert, no-resurrection opportunity upsert, atomic opportunity-plus-alias acquisition (with optional keep-distinct exception resolution), recipient override, and operator decision. Alias acquisition uses a complete sorted advisory-lock set and makes no schema change. No tables, columns, types, status values, thresholds, or policies are added or changed.

## Deliberately unchanged surfaces

Resolver similarity thresholds, alias construction, identity fingerprints, source parsers, score rules/weights/caps/versions, full-backfill authority, Blair ambiguity, automation stages/configuration, delivery settings, schedules, and the production pause state are unchanged.
