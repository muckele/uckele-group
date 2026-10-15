# Private owner setup and bounded no-email handoff

Offline code, tests and publication do not authorize credential creation, private
entry, authenticated inventory or a Machine start. The owner package remains held
until separately approved private setup and exact final session approval.

## Concrete owner package

After the exact reviewed host commit and its CI succeed, use only the fresh,
independently reviewed package bound to that commit. Its `OWNER-HANDOFF.md`
contains the concrete checksum-pinned wrapper command and its artifact manifest
binds the exact recipe, instructions and executable files. The preserved v2
package and the packages bound to `76ced45`, `8d37fc3`, `0a04384` and `2f60079` have consumed owner attempts; none
may be retried or rebound to another source revision.

Run the package's exact command with `--check-only` first. Use the same command
with `--run` only after separate new owner setup authority.
`--check-only` uses no SDK or private input. It verifies the recipe, Python/Node
interpreters, fixed entrypoints, exact clean reviewed host checkout, executable
bindings, concrete output locations and dated public price evidence before any
credential prompt. Changed/stale files or previously consumed evidence hold.
The wrapper contains the final concrete recipe SHA256; there are no placeholder
bundle, evidence or native-helper paths.

Guest commit remains `c4944a46ac362cdcd002e077d5533b4b0843b1d0`; image remains
`registry.fly.io/uckele-group-p10b@sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc`.
The retained Machine helper remains SHA256
`de28af1f823644d0eb4f4cd025b74791b2e041a660cd061cafc67c7175c0b088`.
The new read-only public client is independently bound by path and SHA256 in the
recipe and session. It does not replace the Machine mutation helper.

## Private entry and public evidence

The script first displays the checked recipe digest, dated prices and exact
setup scope. The owner must type the exact private-setup approval phrase. Only
then does it display the nonce-bound two-hour token-creation command using the
recipe's checksum-bound absolute Fly executable. It unsets `FLY_UPDATE_CHECK`
and sets `FLY_NO_UPDATE_CHECK=1`; the force-update variable otherwise takes
precedence. The separate app-scoped public metadata command uses the same
pinned executable and update suppression. Neither command depends on the
owner's shell PATH, alias or a different architecture/version installation.
Never replace either command with bare `fly`. The token-creation command is
for the owner to run personally in a separate private unrecorded terminal.
No automatic issuance, login, refresh, retry, additional credential or account
fallback exists. Keep creation output private.

After successful creation, type the literal word `ISSUED`, **NOT THE TOKEN**, at
the issuance confirmation prompt. Enter the credential only at the later hidden
credential prompt, after public metadata has been validated. The running attempt
allows one correction of a mistaken confirmation entry: it discards the value
without echo or persistence, flushes queued input, explains the expected word and
later credential location, then asks once more. `FAILED` closes immediately.
A second invalid entry, EOF, cancellation or uncertain read/flush closes the
attempt before authentication. Preserve that evidence and retire only the
matching token after clients close. This local correction repeats no issuance,
approval, preflight or runtime; it changes no target, recorded issuance dates,
permission receipt, expiry or session clock. A consumed attempt cannot be reopened.

Before confirming `ISSUED`, have the assisting agent prepare the fixed local
`public-token-metadata.json` file in the fresh package from **verified public
metadata only**. Share only the matching public listing and original issuance
times with the assistant; never send creation output or the credential to chat.
The app Tokens dashboard or the separate pinned app-scoped metadata command
supplies public metadata; creation JSON contains only the credential. No automatic
token creation, authenticated metadata discovery or CLI table parser is added.

The import contract is a 0600 owner-owned plain JSON file in the package's 0700
directory, with exactly `version`, `app` and `tokens` fields. Version is
`p10b-owner-token-metadata-v1`, app is `uckele-group-p10b`, and `tokens` contains
1–128 public rows. Each row has exactly `tokenId`, `tokenName`, `expiresAt` and
`revokedAt`. Times are canonical UTC ISO strings with milliseconds and `Z`;
`revokedAt` can be null. Names use `p10b-runtime-no-email-` plus 24 lowercase
hexadecimal characters. The helper normalizes verified public listing timestamps
when preparing this file, without changing their actual times. The launcher
selects exactly one case-sensitive name for this recipe's nonce and requires it
to be unrevoked. Duplicate IDs or matching names, missing matches, malformed/extra fields,
secret-shaped IDs, duplicate JSON keys, noncanonical times, symlinks, unsafe
permissions, changing files and oversized input hold before credential entry.
The read is bounded through an owner-directory descriptor; nonregular files
cannot block it. Only the validated selected public row is displayed. The
unselected rows and rejected values are never echoed or copied to new evidence.

Then supply the **original** successful issuance start/completion UTC, within
60 seconds, through the existing masked prompts. The launcher imports the local
metadata once: there are no manual ID/expiry prompts, path fallback, polling or
metadata retry. Confirm the displayed row with literal `UNREVOKED`, then literal
`MATCHED` to attest that the private input belongs to that exact new isolated
app-deploy token. Neither confirmation requires copying its ID. The resulting
issuance receipt retains the existing schema, original times and exact imported
ID/name/effective expiry. Requested lifetime or login time cannot prove coverage.
A public timestamp syntax correction does not renew authority. Missing or invalid
metadata consumes the attempt; preserve it and retire the matching token after
clients close. Stage the file before advancing; never reopen a consumed package.

The credential-free public-input validator runs before hidden credential input, and the
preparer repeats admission at the actual preflight start. Bad ID, timing, expired
scope or insufficient effective coverage holds before hidden input/authentication.

A private TTY is required; getpass echo-fallback warnings are errors. Credential
bytes remain in private process memory/environment and possible isolated SDK
state, never argv, public JSON, receipts, source or guest configuration. The
launcher does not decode the input to independently prove the owner's selection.
Local metadata selection is still owner-attested public evidence, not independent
proof that the opaque credential has that ID. Agent preparation and later
approved automated test/cleanup do not authorize agent credential access. Private
creation and hidden credential input remain owner-only; exact runtime approval
remains a separate owner decision.

## Supported names-only preflight

The normal Fly SDK uses the installed flyctl v0.4.115 GraphQL schema's supported
`app(name: "uckele-group-p10b") { secrets { name } }` selection. Its own AppData
fragment requests `secrets { name }`. The request selects no value/digest field;
unexpected response fields fail closed before hashing/output. There is no REST
`secrets list --json` fallback in no-email preparation. Preparation binds the
canonical sorted-name inventory hash. Qualification keeps its existing metadata
contract and still requires separate email authority.

The bounded preflight performs two fixed-app stopped-Machine reads, independently
admits names before public values, validates the complete public configuration
with both host and retained pure native policy, and keeps only the admitted
public projection. It checks the exact immutable registry manifest with the same
opaque token using normal Fly token representation and Docker SDK. It makes no
build/push or Machine mutation. Unsupported app-token GraphQL/registry access
holds; it never substitutes account credentials.

Fly/Docker HOME/config state is private and isolated. A nonempty registry auths
entry disables Docker's automatic credential-store discovery; no credential
helper/store is configured. The exact buildx search directory is pinned. No owner
Fly/Docker config or keychain is read. All preflight commands durably reserve
pending intents, run in owned groups, and require verified group absence before
retiring intents. Exited leaders do not release group ownership. Uncertain
reaping/directory identity/cleanup retains 0700 private SDK state and denies
handoff. This is possible temporary disk storage of credentials, not a memory-only
claim. Do not manually clear unresolved intents.

## Concrete final runtime approval

The one-hour clock freezes before the first authenticated preflight. Preparation
and review consume this original window; nothing renews it. Preflight must finish
within two minutes. Its positive private cleanup gate precedes bundle sealing.
The script shows the full sealed public bundle and its exact Node-canonical
session digest (including monetary floats), then requires the owner to type the
exact session approval phrase. It preserves the unapproved seal and writes a
separate approved bundle/approval receipt only after this explicit decision.

The source/image/public/native bindings, original deadline, recovery paths and
historical expected bytes all enter that session digest. The runtime performs
fresh independent stopped-baseline verification and positive archival recovery;
it preserves historical attempts/uncertain cleanup evidence. An absent old lock
alone cannot authorize admission. The current reviewed launcher permits at most
two five-minute starts and three stopped configuration updates including exact
restore. Private reap proof precedes restoration; known fixed-auth native reopen
is permitted only for exact baseline restoration. No host stop/retry or new start
is introduced. Guest shutdown owns permission/ingress/SQLite/artifact closure.

Success requires runtime closure plus authenticated-client and private-directory
cleanup proof. The outer launcher also verifies its owned process group.
Darwin's signal permission error for an
exited unreaped leader is resolved only by its exact child wait and an independent
group probe returning ESRCH; active children, present groups and denied probes
hold without further signaling. Timeout,
refusal, replay or uncertainty preserves evidence and denies success. After closed
clients, the owner must manually revoke only this new matching public token ID
under the setup/runtime approval. No automated revocation is implemented. An
uncertain runtime may need separately approved incident handling; expiry is not
an immediate revocation receipt.

## Cost and retained limits

The $1 amount is an operational budget/estimate, **not a guaranteed billing cap**.
The retained October13 18:05:45 UTC public snapshot estimates ten minutes of EWR
shared 1 CPU/512 MB compute at $0.00085417 ($3.69/30 days). The existing 1 GB volume
continues at about $0.15/month while stopped. Stopped rootfs costs $0.15/GB/month;
its actual size is unknown. Snapshots cost $0.08/stored GB/month (earlier count
zero, not rechecked); North American egress costs $0.02/GB. Separate registry
charges remain unverified. Retained storage continues after stopping. Stale or
changed price evidence must be resolved before starting the token clock.

No new capacity/storage, additional build/push, provider call, email, production
change, merge or deployment is authorized. `productionReady=false`; global
automation remains paused. Sender remains `P10B Sender
<sender@p10b-e2e.uckelegroup.com>` and eventual recipient `mathew@uckelegroup.com`.
A future one-email qualification needs separate approval.

Primary SDK sources: [supported names-only fragment](https://github.com/superfly/flyctl/blob/v0.4.115/gql/genqclient.graphql),
[GraphQL Secret schema](https://github.com/superfly/flyctl/blob/v0.4.115/gql/schema.graphql),
[Fly SDK transport](https://github.com/superfly/fly-go/blob/v0.11.3/client.go),
[normal Docker token representation](https://github.com/superfly/flyctl/blob/v0.4.115/internal/command/auth/docker.go).
