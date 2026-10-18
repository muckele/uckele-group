# Read-only admission of an already archived reservation

The stopped-update diagnostic can encounter a historical reservation that an
earlier session has already retired. Its diagnostic-only `recovery.priorArchive`
binding freezes the old nonce/session digest and exact SHA256/path bindings for
the original recovery intent, terminal and independent verification. The archive
keeps its original nonce/path. Legacy no-email sessions cannot use this mode.

Static owner-recipe checks verify these local public records before setup consent
or credential entry. The active name must be absent by `lstat` with ENOENT as the
only absence result; a dangling symlink or read uncertainty holds. Coherent
bounded descriptor snapshots verify owner/mode, bytes and identities, pinned
receipt schemas/hashes, archive and attempt hashes, original archive inode/device,
session lineage, separate verifier/operator PIDs and original chronology. Directory
anchors reject symlink ancestors and replacement during reads. Historical times
are provenance; they are neither retimed nor accepted as current authority.

After separate final diagnostic consent and fresh exact stopped-baseline reads
by the owner process and an independent process, this branch writes only new
session evidence: `p10b-existing-archive-admission-intent-v1` and
`p10b-existing-archive-admission-terminal-v1`. They describe admission verification,
not another retirement. They bind the new session digest, current baseline
proofs and one digest of the original bindings and observed file/directory
identities. `archivePreserved=true`, `activeAbsent=true` and
`historicalCleanupVerified=false` are explicit. No host-admission link, unlink,
rewrite or rearchival occurs.

A separate verifier reopens and checks the complete historical chain, then emits
fresh independent verification for this new session. Every later diagnostic
admission rechecks the same chain and active absence. Missing, changed, crashed,
replayed or transplanted evidence holds; no branch falls back to retirement or
old approval. Freshness is checked after inspection, and the controller rechecks
its original deadline and dispatch reserves after potentially slow admission.

The zero-start, maximum-one-diagnostic/one-eligible-restoration POST contract,
10-second request/observation bounds, 120-second operation limit, 15-minute
approval window and permanent uncertain-outcome holds remain unchanged. Setup
and exact-session diagnostic consent are still separate. This source change
authorizes no live operation, credential issuance, Machine start or email.

## Safe owner diagnostics

The stopped-update CLI now retains a closed operator report through nonzero child
exit and local cleanup. It names the failing step, typed request method/status,
last validated observation versus an uncertain dispatched mutation, restoration
verification, client closure and private cleanup. HTTP 401/403 means authentication
or authorization rejection; it does not prove token expiry or unchanged server
state. Timeout, rejected update and restoration failure preserve the conservative
no-retry policy. Cleanup failure after verified restoration retains both facts.

Only fixed enums, bounded public status and a session-bound digest/time cross the
owner console boundary. Raw exception text, response bodies, headers, credential
values and private directories are excluded from that summary. Python validates
the exact schema after positive child-group closure, then checks the sealed
session digest before emitting/persisting it. Invalid or missing reports fall back
to an uncertain held state. Reports grant no retry, recovery, new credential or
cleanup authority. Next actions are preserving evidence for independent review,
manually revoking the matching token only after closed clients, or separately
approved incident handling when local closure/cleanup remains unverified.
