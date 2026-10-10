# Offline executable no-email handoff

The implementation is executable and covered by stubbed boundary tests. The
packet in `templates/p10b-no-email-session.json` remains **SESSION_NOT_APPROVED**.
This is code/test/review preparation only. No new image build/push, authentication,
reservation recovery, Machine action, provider call, email or production change
has been performed for this package.

## Prepared entry points

```sh
node scripts/run-p10b-no-email-session.js --validate-template templates/p10b-no-email-session.json
```

This validation reads the held public template, returns its missing prerequisites,
and cannot construct authentication or filesystem recovery boundaries.

## Required complete baseline preflight before replacement image work

Template validation proves the held contract only. The original offline operator
fixture used an empty environment, and the build package relied on historical
baseline identity/capacity without validating the current complete configuration
through the host and native schemas. Seven existing public key names were therefore
missed until after the one-build/one-push allowance was consumed. That allowance is
closed. Do not use the earlier partial projection as a complete baseline.

Before any separately approved replacement image build, collect a fresh stopped
public baseline under that approval. Inspect its environment **names first**;
reject unknown names before selecting values. Retain every admitted public value
without normalization or omission, and compute the full canonical config digest.
No secret values, credential-store data or value-derived secret digests belong in
the file. Validate the clean reviewed checkout and the actual complete shape:

```sh
node scripts/run-p10b-no-email-session.js --validate-baseline /fresh/public-baseline.json
```

The envelope has version `p10b-public-baseline-preflight-v1`, fixed `app`,
`machineId`, `volumeId`, final `sourceHead`, observed `instanceId`, `state=stopped`,
`observedAt`, independently captured `observedEnvironmentNames`,
`fullConfigurationRetained=true`, full `baselineConfig`, `baselineImageDigest`
and `baselineConfigDigest=sha256(stableCanonicalJson(baselineConfig))`.
The command rejects evidence older than 30 minutes, future observations, missing
or duplicate names, dropped values, changed config/image digests and a changed or
dirty source checkout. Its public receipt contains the full digest, source/image,
instance, time and name count; it prints no environment values and opens no
authentication, registry, recovery, SQLite or Machine boundary. Keep the envelope
and receipt sealed with the replacement build intent. Recheck all bindings and
freshness immediately before any build/spend; failure consumes no build or push.
Native admission independently applies the same typed policy before loading
authentication. Both validators consume shared public-value regression vectors;
the full operator flow now uses the observed 25-key shape with explicitly
synthetic values for the seven formerly omitted names. Future unknown keys remain
closed and require their own offline semantic review.

| Name | Public meaning and narrow admitted values |
| --- | --- |
| `ADMIN_ALLOW_PASSWORD_AUTH` | Auth feature switch: exact `true` or `false`; never a password. |
| `ADMIN_AUTH_MODE` | Auth behavior: only `password`, `magic-link`, `hybrid`; never auth material. |
| `ANALYTICS_ENABLED` | Local analytics switch: exact `true` or `false`. |
| `BACKUP_ENABLED` | Local scheduler switch: exact `true` or `false`. |
| `OUTBOUND_HTTP_TIMEOUT_MS` | Public request deadline: canonical decimal integer 1..10000 ms; rejects aliases, exponents and unbounded timeouts. |
| `PUBLIC_SITE_URL` | HTTP(S) origin with a bounded DNS hostname whose final label starts with a letter, or canonical four-octet IPv4, optional port 1..65535 and optional root `/`; no userinfo, other path, query or fragment. |
| `SECURE_DOCUMENTS_STORAGE_DIR` | Canonical non-root `/data` descendant with safe literal segments, or exact container default `/app/data/secure-documents`; no traversal, encoded or ambiguous segments. |

All seven settings are preserved byte-for-byte through both candidates and exact
baseline restoration. Accepted settings do not grant runtime permission:
`password`/`hybrid` can enable password auth despite a false feature switch, so
preparation safety relies on the existing ingress guard rejecting admin,
analytics and document routes, and startup/scheduler guards suppressing ordinary
cleanup/backup work. The frozen candidate flags separately enforce no-email
provider/automation hard-offs. Credential namespaces, `NODE_OPTIONS`, `LD_PRELOAD`,
unknown keys and credential-shaped/control-containing values remain denied.
Name-only evidence does not prove the seven real values pass this policy; a fresh
complete admitted baseline is still required before replacement image work.

After separate owner approval and image preparation, the exact clean reviewed
checkout and an existing private fresh evidence directory support one handoff:

```sh
node scripts/run-p10b-no-email-session.js --execute --bundle /approved/public-bundle.json --evidence /fresh/private-evidence --native-client /approved/p10b-machine-client
```

This command is documentation, not current execution permission. `--run` uses an
already completed independently verified recovery instead. A held/closed/consumed
session or pending/crashed recovery always refuses runtime admission.

The bundle freezes exact source/image/manifest and native executable SHA256, public baseline configuration,
provider identity/name metadata, owner permission, price/cost, one-hour absolute
session and public owner-attested authentication expiry covering that session.
No credential material is included or inspected to infer expiry. A six-minute
login does not cover a roughly ten-minute demo plus preparation/restoration.
The agent never renews authentication. Missing/expired authentication fails closed.

## Concrete execution order

1. Validate approval, clean source, fresh immutable image prerequisite, fixed
   app/Machine/volume/capacity, pause/hard-offs and private noncolliding evidence.
   Read-only recovery clients use normal SDK authentication, including a separate
   verifier process, to bind a fresh exact stopped baseline.
2. Under explicit exclusive-writer recovery approval, write/fsync an intent;
   link the exact old active inode to a noncolliding uncertain-history archive;
   verify bytes/inode/device/owner/mode/mtime and fsync archive/directory. Recheck
   freshness, time, active/attempt identity, then retire only the active name.
   Write/fsync terminal facts. A separate process verifies archive/attempt facts.
   Preserve the old per-packet attempt and all failed evidence. This proves
   reservation recovery, never historical cleanup or lifecycle success.
3. Require positive independent recovery proof before runtime authenticated
   boundaries. Read exact sole-Machine metadata; use exact frozen update DTOs
   with no lease refresh or POST retry. Consume an exclusive intent before each
   update/start. Check time again immediately before mutation.
4. Attach a separate OS-session observer with its own read-only native client
   and bounded Fly JSON log stream before the demo start. Poll at750 ms; busy,
   failed, missing, wrong-instance and request/response gaps over1000 ms fail.
   Retain only closed guardian lifecycle rows, normalizing platform RFC3339
   fractional timestamps to milliseconds (under1 ms quantization).
5. The inert demo and secret-free parent/guardian use a fresh five-minute
   prepare window,30-second closure/stop reserves and no listener/database.
   After exact living readiness and fresh-path checks, kill/reap only the primary
   local session. The independent observer must survive through the cutoff.
   Require one exact parent-reaped guardian code0 event, normal whole-Machine
   exit, no restart, and stopped convergence within30 seconds and the cutoff.
6. Only a fresh successful demo enables the standard no-send preparation.
   Its child retains exit and host result; acceptance binds packet/source,
   configuration and guest-window/closure receipt, ingress/SQLite closure and
   stopped/reaped certainty. The independent observer also binds receipt hash,
   chronology, normal exit, convergence and continuous stopped coverage.
7. Reap local controllers; on failure preserve bounded read-only observation
   through the original cutoff. No host stop, renewed window or retry is added.
   Restore only a known exact stopped candidate to the frozen baseline. Close
   authenticated clients, then publish sticky session terminal facts. Uncertain
   reaping/restoration/closure denies success and holds all subsequent work.

A failed current preparation may retain its new host active reservation. That
exact packet/evidence/window-bound record remains untouched. It permits only the
already admitted phase's bounded observation and stopped-baseline rollback;
an unrelated active record denies both. No active reservation admits a new phase.

At most two starts, three stopped updates, one future local image build and one
future push fit the frozen one-hour/<$1 envelope. The no-email session admits
zero provider calls and zero emails. `productionReady=false` and automation stays
paused. Source imports perform no authentication, recovery or Machine actions.

## Remaining live prerequisites

The owner must separately authorize and bind the exact final commit, one rebuilt
isolated image/registry manifest, current public baseline/configuration/name and
price evidence, fresh nonce/evidence/window and no-email permission. The owner
must provide normal authentication with public expiry coverage and exclusive
admission writers for exact archival recovery; the old lock must not be deleted
or cleared without the approved verified archive transaction. The final image
must pass a fresh real guardian timing demonstration. Historical timing is
component evidence only and cannot satisfy that gate.

Any email requires another future reviewed preparation/transmission/payload/alias
and narrowly scoped permission for exactly one message from
`P10B Sender <sender@p10b-e2e.uckelegroup.com>` to `mathew@uckelegroup.com`.
There is no email approval, merge or deployment in this package.
