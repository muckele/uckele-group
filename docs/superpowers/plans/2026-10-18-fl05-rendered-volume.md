# FL05 rendered growth-volume verification

Base: reviewed PR79 `d79ee6d300e3b617cd1e51fe826e678806e77dc0`.
Close the remaining rendered portion of FL-T65 without expanding architecture.

Reuse the same private-HOME/SQLite fixture, 1000 materialized current rows and 5000
historical archives, denied external boundaries and owned-browser registration.
Extract only the existing test fixture helpers so API/browser datasets match.
Add one fixed runner mode and CI command. No runtime/dependency/schema changes
unless an actual observed failure justifies a minimal independently reviewed fix.

Exercise real Chromium UI against real Express/password routes at 1440x1000 and
390x844: queue and archive totals/pagination, bounded rendered rows, archive search,
lazy detail, same-row context/focus on Escape, mobile overflow, keyboard trap and
scroll. Record event-to-verified-render observations (capture listener through
assertions and two animation frames), 10 samples per repeated action/viewport,
long tasks and renderer heap/DOM metrics. These include test synchronization
overhead and are not standardized INP, production percentiles or mobile hardware
benchmarks. Preserve partial observations, screenshot/trace and exact source.

No decisions, facts or outreach actions in this read-only journey. Compare full
protected fingerprints and require no external attempts or browser errors.
Run unchanged API volume and owner flow regressions, independent review, commit,
stacked draft PR and literal-head CI. No merge/deploy/live operation.

Finish with a finite MVP acceptance assessment: required human owner adoption and
any concrete unresolved offline criterion remain explicit; broader device/store
benchmarking is optional unless a failure establishes a product need.

Observed defect: the first rendered archive detail request returned 404 when its
retained score was no longer current, despite its searchable Pass remaining.
FL-T43/44 require retained archive evidence. The minimal fix permits an explicitly
read-only historical detail only for the exact active canonical id, retained score
id/key, current dismissed disposition and compatible CRM binding. Superseded,
restored, unarchived and foreign evidence remain denied; current-score mutation
guards are unchanged. Add hostile identity tests and drawer mutation-control
coverage. Preserve the original browser/service RED evidence.
