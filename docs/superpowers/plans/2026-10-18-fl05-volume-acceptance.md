# FL05 bounded volume acceptance

Base: PR78 `4ef46d29452a99f553c48202102e9396a777a184`.
PR78's exact-head CI and retained clean local backend/browser evidence already
close the canonical-restore rerun. Human owner adoption remains pending.

The next unmet offline gate is FL-T65 / roadmap section 13.3: a full supported CSV
batch and a materially larger archive with documented latency, bounded responses,
memory and query behavior. Existing FL05 coverage uses eight opportunities.

Reuse the existing private-HOME, deny-external-network, paused-automation fixture
runner. Add an explicit volume verification mode, not a new runtime service.
Upload 1000 synthetic CSV rows through authenticated real HTTP; retain honest
import/scoring-stage results without inventing source health. Seed 1000 current
projection rows and 5000 historical ineligible scored archives in only that fresh
fixture. This is a scale fixture, not importer or production-data equivalence.

Measure identical queue/detail/archive paths before and after growth (first request
plus 30 warm samples, nearest-rank p95), response bytes and process RSS. Verify
bounded page sizes, deterministic ties and archive availability after eligibility
loss. Record representative query plans and protected-state fingerprints before
and after read-only measurements. Timing targets are documented pilot objectives,
not production guarantees or noisy absolute CI pass thresholds.

No runtime optimization unless a measured defect justifies it. No new dependency,
schema/index/permission change, worker, provider call, live record or deployment.
Any confirmed scoped defect gets a failing regression and separate review.

Run the new verification locally and in exact-head CI, preserve evidence outside
git, obtain independent review before commit/push, and open a separate stacked
draft PR. Update the acceptance checklist with actual evidence and retain the
human-owner/live gates. No merge/deploy/project migration/send.
