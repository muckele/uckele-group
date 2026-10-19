# FL03 typed operator financial facts

Observed owner acceptance blocker on PR80: Missing Information lists Earnings,
Revenue and Asking price, but no supported editor/API field exists. Customer
concentration is already editable. Note-search confusion is discoverability
friction, not a confirmed search defect. Restore/full adoption are unverified.

Fix the financial workflow and the owner-reported Restore, score explanation,
and future CRM guard blockers in a separate checkout; never
modify/restart the owner's active fixture or built assets. Keep its scheduled
stop and evidence capture. No production, provider, email, merge or deployment.

Reuse immutable operator fact rows and existing current-canonical revision,
13-field CRM snapshot and idempotency checks. Add three supported field names
with a closed versioned financial value: bounded exact decimal amount, currency,
field-compatible metric, period (or explicit unknown), evidence source; existing
actor/verified/note/timestamps remain the audit envelope. Preserve source facts,
scores and history. Show operator provenance/verification and disclose that the
stored machine score is unchanged. Do not retain a stale derived multiple as an
effective corrected financial ratio.

SQLite's inline field CHECK requires a lossless transactional upgrade preserving
rows/digests, FK, indexes and authority triggers. Widen the PG boundary and both
RPCs with matching typed-value checks, without widening contact snapshots.
No actual project database migration is authorized; exercise fresh/upgrade only
on disposable fixtures. Record rollback: disable new financial editing, retain
all typed financial history; old application versions must not assume they can
render new fields. Do not downgrade/drop history.

RED/GREEN proof: unsupported-field regression, strict numeric/currency/context
validation (zero/negative earnings/overflow/precision), append/replay/conflict,
stale/superseded/viewer denial, SQLite upgrade preservation, PG fresh/upgrade and
raw bypass denial. Real rendered save/reopen/reload and source refresh must keep
corrections/provenance while clearing only corresponding missing indicators.
Independent final patch review precedes commit/push; stacked draft and literal
head CI required. Human adoption remains blocked until owner rechecks the fix.


Current unlinked Restore uses a dedicated admin route and atomic storage/RPC.
Bind the current canonical revision plus exact retained Pass ID/updated instant;
require active/current score, primary null, sole canonical-key Pass/null binding,
no conflicting alias ownership, no other alias Pass, no reverse CRM or retained
import/CIM link. Preserve original Pass fields and write existing restoredAt/by;
advance canonical authority to invalidate old confirmations even at fixed clocks.
A repeat/conflict is409 with no mutation. Legacy canonical Restore cannot bypass
this contract. Linked CRM Restore continues through the existing coherent path.
No CRM record is fabricated, outreach remains stopped, opt-outs/permissions and
terminal campaign/enrollment state remain unchanged. Restore audit columns are
current-row history, not a new immutable restore-event ledger.

Legacy score explanation adapts the consolidated flat detail response's score
object without assuming a success envelope. Future isolated replay guard admits
bounded read-only CRM index/duplicate-report/known-record navigation, keeping
setup/send/unrelated mutations denied. The already closed human session is not
modified or restarted. Automated fresh headless fixtures do not constitute owner
acceptance. Independent review findings and failing regression artifacts remain
in external evidence; do not rewrite them as passes.
