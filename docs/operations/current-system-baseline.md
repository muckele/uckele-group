# Current system baseline — 2026-09-22

This records the owner's completed, fixed-pair Pooler/Berlin V3 CRM duplicate-consolidation handoff. It is not authority for another repair, reconciliation, send, deployment, or automation change.

## Reported production state

- Fly release `v127` runs revision `52e8753119d320a7299021d6a42ad3d3dd8db0b1` with 1024 MB live memory. This repository closeout aligns the `fly.toml` memory declaration; the new repository revision is **not deployed** by this change.
- One authorized V3 apply changed exactly four rows: two intended supersession relations, the Berlin legacy-import compare-and-set update, and one immutable receipt. The original four contact records and their origin-attributed histories remain preserved.
- The owner's read-only post-state verification found the intended relationships, valid receipt, clean SQLite integrity, and unchanged protected tables, schema, and safety controls. Independent verification reported no P0, P1, or P2 findings.

The private owner-local evidence package is at `/Users/Matt/.local/share/uckele-group/restricted-evidence/pr20/applies/20260922T234500Z-v127-52e87531/`. Its `SHA256SUMS` file was reported with SHA-256 `a08ce95318d426a06a0fe160bf85b0cf79a95832e638ceac05f8e8115ba7273c`. The package contents are not part of this repository.

## Limits and next boundary

- Production UI routes were not exercised; the read-only storage projections were verified. Earlier browser intermittency remains unexplained.
- This closes only the two fixed duplicate pairs. It does not establish that every CRM duplicate is resolved.
- CRM reconciliation, provider sending, and automation activation were not part of the apply; sending and activation remain separately governed.
- No new post-apply backup or volume snapshot was created in the apply task. Preserve the receipt-bound recovery evidence before any future cleanup.
