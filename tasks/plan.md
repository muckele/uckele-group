# Implementation Plan: FL-04C Atomic Follow-Up Preparation Capacity

## Overview

Add a dormant, local-only FL-04C preparation path that claims one due follow-up,
rechecks current authority, and atomically persists its immutable transmission with
a bounded capacity reservation. No route, scheduler, provider call, startup hook,
activation change, or deployment is part of this slice.

## Architecture Decisions

- Add a retained `deal_hunter_cim_capacity_reservations` ledger. Reservation
  identity and bindings are immutable; lifecycle advances only from `reserved` to
  `consumed`, `released`, or `expired`.
- Add `prepareReservedCimFollowUp` as the only new preparation mutation. It uses
  database execution time, serializes the Pacific-date and normalized-recipient
  capacity keys, derives caps from the current `fl04c-followup` activation, invokes
  existing immutable preparation inside the same transaction, and inserts exactly
  one reservation.
- Daily capacity counts nonreleased reservations for the current
  `America/Los_Angeles` date. Recipient capacity counts unexpired reservations and
  consumed transmissions in a rolling 24-hour window. A unique active campaign
  reservation prevents two prepared follow-ups for one campaign.
- A reservation expires no later than its claim lease. An expired, never-invoked
  preparation may renew its claim and capacity against the exact same immutable
  transmission; it cannot change recipient, payload, touch, campaign, or policy.
- Cancelling before provider authorization releases capacity. The durable
  `prepared -> provider-pending` transition consumes capacity atomically. Consumed
  capacity is retained across accepted, definitive-failure, pending, and ambiguous
  outcomes and never authorizes resend.
- Recipient fingerprint equality is exact across candidate, campaign,
  conversation, current recipient authority, and reservation. Current reply,
  materials, advanced diligence, suppression, delivery risk, CRM ownership,
  campaign expiry, and terminal authority are checked before and after claim; the
  database transition rechecks its durable subset.
- PostgreSQL migration is additive and service-role-only. SQLite startup schema is
  additive. Old code ignores the ledger safely; rollback means disabling the
  dormant capability/application version while retaining evidence, never deleting
  reservations or transmissions.

## Task List

1. Specify reservation schema, state invariants, and normalized adapter results.
2. Add RED tests for service fail-closed behavior, SQLite races/lifecycle, and
   PostgreSQL migration/RPC parity.
3. Implement SQLite schema, transaction composition, renewal, and lifecycle
   triggers.
4. Implement mirrored PostgreSQL migration/RPCs and Supabase adapter methods.
5. Implement the dormant injected service composition without any send surface.
6. Run focused checks, independent review, full applicable checks, and exact-head
   draft-PR CI.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Two workers consume the final slot | Serialize daily then recipient keys and count/insert in one transaction. |
| Detached time revives an expired owner | Storage reads execution time internally; callers cannot supply reservation time. |
| Midnight changes the daily bucket | Reservation expiry is capped at the next Pacific midnight; reprepare under the new date. |
| Crash leaves capacity stranded | Unconsumed reservations expire with the claim and may be renewed only for the same immutable transmission. |
| Terminal race after claim | Recheck authority before mutation; terminal writers cancel prepared work and release only unconsumed reservations. |
| Provider ambiguity permits another send | Provider-pending consumes the reservation permanently; ambiguity stays reconciliation-only. |

## Open Questions

None. The owner approved the material atomic-reservation architecture. Any further
scope beyond this dormant preparation boundary requires a separate stop and report.
