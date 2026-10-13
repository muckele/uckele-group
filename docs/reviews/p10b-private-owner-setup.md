# Private owner credential setup and bounded runtime proposal

This is a future proposal. The launcher correction was approved for offline
implementation, tests, review and publication only. No token creation, entry,
authentication, Machine action, image work or runtime is authorized by this file.

## Frozen artifacts and separate host revision

`session.sourceHead` remains guest commit
`c4944a46ac362cdcd002e077d5533b4b0843b1d0`. The immutable image remains
`registry.fly.io/uckele-group-p10b@sha256:50bc9c9ea37207586f347134e62de15aa21641920d3db50b67e99a4916989bfc`.
The retained native executable SHA256 is
`de28af1f823644d0eb4f4cd025b74791b2e041a660cd061cafc67c7175c0b088`.
`session.hostSourceHead` and `approval.hostSourceHead` must identify the final
independently reviewed clean launcher commit. Both are bound by the session digest.
Guest packets/windows/configuration still carry the guest revision. The narrow
preparation exception requires the exact derived no-email preparation packet;
standalone qualification cannot borrow the new host binding.

## Owner setup, only after separate approval

1. Prepare a fresh public bundle with the final host revision and a fresh nonce.
   Keep its status held until all prerequisites and owner approval are complete.
2. In your own private terminal, outside Codex/transcripts/recorded shells, create
   one app-scoped credential with the exact nonce-bound name and explicit expiry:

   ```sh
   fly tokens create deploy --app uckele-group-p10b --expiry 2h --name "p10b-runtime-no-email-<nonce>"
   ```

   This prints credential material. Do not paste it into chat, command arguments,
   source, public JSON, evidence or a persistent owner configuration file. Keep
   the credential privately for the hidden-input handoff below. No general account
   permissions or production credentials need to change. If creation fails, stop;
   no login, retry or renewal is implied by these instructions.
3. Record UTC timestamps immediately before and after successful creation, and
   inspect the matching managed token's public ID/name/effective expiry/revocation
   status in the app's Tokens dashboard or:

   ```sh
   fly tokens list --app uckele-group-p10b
   ```

   Publish only the matching public fields. `create deploy --json` contains only
   the credential; it does not provide public expiry metadata. `auth whoami` and
   a known login time cannot supply future coverage.
4. Populate `authenticationEvidence` with version `p10b-app-token-issuance-v1`,
   `ownerAttested=true`, `issuanceSucceeded=true`, `app=uckele-group-p10b`,
   `scope=app-deploy`, the matching public `tokenId`, nonce-bound `tokenName`,
   `issuanceEvidenceId`, canonical UTC `issuanceStartedAt`,
   `issuanceCompletedAt`, `requestedLifetimeMs=7200000`, `revokedAt=null`, and metadata-derived
   canonical `expiresAt`. Attest that the privately supplied credential is the
   same newly created, unrevoked token described by this receipt. The launcher
   does not decode credential bytes to independently prove that selection.
   Creation must complete within 60 seconds and before the session starts.
   Effective expiry must fall within the creation-time bounds plus two hours
   (one second allowed for server timestamp quantization) and cover the entire
   original session deadline. Missing metadata, clock mismatch or insufficient
   coverage holds admission; requested duration alone cannot pass.
5. After the final public bundle receives fresh explicit runtime approval, use
   the hidden input from a private terminal in the final clean checkout:

   ```sh
   python3 -c '
   import getpass, os, subprocess, sys, warnings
   if not sys.stdin.isatty():
       raise SystemExit("Private terminal required")
   warnings.simplefilter("error", getpass.GetPassWarning)
   environment = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
   environment["FLY_API_TOKEN"] = getpass.getpass("Temporary app token (hidden): ")
   raise SystemExit(subprocess.call([
       "/Users/Matt/.nvm/versions/node/v22.23.2/bin/node",
       "scripts/run-p10b-no-email-session.js", "--execute",
       "--bundle", "/approved/public-bundle.json",
       "--evidence", "/fresh/private-evidence",
       "--native-client", "/approved/p10b-machine-client"
   ], env=environment))
   '
   ```

   The input is memory/environment only. The launcher creates a fresh 0700
   temporary `FLY_CONFIG_DIR`, retains the real HOME for archival admission paths,
   strips competing auth/endpoint overrides and supplies only the opaque app
   credential to approved local SDK/Fly processes. It never supplies it to guest
   configuration. Success requires both runtime closure and authenticated-client
   reap/private-directory cleanup proof. Uncertain cleanup remains held with the
   private directory preserved. Each local process durably reserves a secret-free
   pending-reap intent before launch and retires only its own intent after actual
   verified closure. Remaining descendant intents, marker/filesystem errors or
   changed directory identity hold cleanup. Do not manually clear unresolved
   intents. Timestamp comparison presumes synchronized local and server UTC
   clocks; mismatch fails closed without shifting permission times.
   Before any baseline restoration, local controllers and the current native
   client close, and the root independently requires the original private
   directory identity and no unresolved descendant intents. Only then can an
   exact baseline update use a new native connection with the same credential;
   no POST retry or new start is added. This keeps guardian configuration in
   place while a possible start-capable descendant remains unproved.
6. After all clients are proved closed and the frozen stopped baseline restored,
   revoke only this temporary token through its public ID in the app dashboard
   or `fly tokens revoke <matching-public-ID>`. Revocation needs its own explicit
   authority within the setup/runtime approval. No automated revocation or token
   creation is built into the launcher.

## Revised bounded runtime proposal

Approve only the final reviewed host commit, unchanged guest/image/native
identities, one owner-created/private-entered two-hour app token and its exact
public receipt, fresh names-only isolated secret metadata, complete stopped
public baseline, immutable manifest verification, cost evidence and exclusive
archival recovery evidence. The public image/baseline admission evidence must be
at most 30 minutes old; retained October 13 observations are not current proof.
The owner permission digest and exact session digest must bind these facts.

The session remains one nonrenewable hour with at most two five-minute starts,
three stopped configuration updates including exact baseline restoration, and
less than $1 incremental cost. Keep the independent observer, guest guardian,
permission closure, artifact/SQLite cleanup before stop, one-shot stop arbitration,
bounded stop verification and archival preservation. No host stop/retry, auth
renewal, additional image build/push, provider call, email or production change.
`productionReady=false`; global automation remains paused. A future one-email
qualification requires separate approval.

Primary support: [Fly access tokens](https://docs.fly.io/security/tokens),
[installed CLI source: token creation](https://github.com/superfly/flyctl/blob/v0.4.115/internal/command/tokens/create.go),
[public managed-token listing](https://github.com/superfly/flyctl/blob/v0.4.115/internal/command/tokens/list.go).
