# Task 6 review-fix round 1 report

## Scope corrected

- Added abortable, monotonic-generation queue and detail reads. Only the current generation may commit rows, summary, loading, detail, or read errors; aborts remain silent.
- Bound drawer actions and verified-fact saves to the currently loaded detail only when its canonical `opportunityId` matches the current selection. Closing or reopening invalidates the prior detail generation.
- Refreshed the still-selected matching detail after Pursue/Watch. Pass now refreshes the queue and closes the matching active drawer, removing stale action controls.
- Replaced `window.prompt` with an in-app Pass form for both drawer and queue actions. Reason is required and bounded to 80 characters; note is optional and bounded to 2,000 characters; both use the existing `/action` route.
- Added explicit row-level review, operator (including normal), machine, CRM/CIM workflow, observation freshness, and passed/disposition context.
- Rendered the existing bounded Task 5 projection across overview state/counts/freshness, score summaries and full evidence context, source conflict field names, CRM facts/conflicts, CRM/CIM communication rows, and operator review/fact/activity/disposition audit context.
- Corrected search and sort copy without changing backend search or sorting semantics.
- No backend route, service, storage, scoring, identity, import, outreach, CIM-send, or Stage 2 behavior changed.

## Behavioral TDD evidence

All commands used `PATH=/Users/Matt/.nvm/versions/node/v22.23.2/bin:$PATH`.

The first focused run was blocked before collection because Vite could not write `node_modules/.vite-temp` under the sandbox (`EPERM`). The same command was rerun with approved worktree write access.

RED was captured before the production correction:

- Focused suite: 2 files failed; 8 tests failed and 6 passed.
- Reverse queue resolution rendered `Stale Controls Co`, replaced the current summary count `7` with `99`, and allowed the stale finalizer to control loading.
- Reverse detail resolution rendered `Opportunity A` after `Opportunity B` had already loaded, demonstrating the selected/detail identity split.
- Pursue/Watch left detail load count at 1 instead of refreshing the selected record.
- Pass called the action callback immediately and had no bounded form; the integration test could not find the required `Pass Evergreen Fire Protection` form.
- Correct-copy assertions saw `Business, geography, or deal key` and `Newest observation`.
- The bounded detail-category assertion first failed at missing completeness (`88%`) and therefore protected all subsequent supplied projection assertions.
- A focused mutation check removed the explicit review prefix and failed exactly at `Review: Needs Review`, proving the scan-state assertion discriminates the required signal. The production line was restored before GREEN verification.

GREEN after the smallest coherent UI/test correction:

- Focused Task 6: 2 files passed; 14/14 tests passed.
- Relevant Deal Hunter/Dashboard set: 7 files passed; 55/55 tests passed.
- Full UI suite: 22 files passed; 139/139 tests passed.
- All final verification suites had zero failures, skips, or todos.

## Verification

- `npx vitest run test-ui/AcquisitionInbox.test.jsx test-ui/OpportunityDrawer.test.jsx` — 2 files, 14 tests passed.
- Relevant seven-file Deal Hunter/Dashboard Vitest run — 7 files, 55 tests passed.
- `npm run test:ui` — 22 files, 139 tests passed.
- `npm run lint` — passed with zero warnings.
- `npm run build` — passed; 1,642 modules transformed and metadata prerendered for 9 public routes.
- `git diff --check` — passed.
- Safety scan of the two UI components found no review/backfill/send/CIM/import/Stage 2/score-refresh route or control, and `Not provided` appears only in the `missingCriticalFields` renderer.

## Files

- `src/components/admin/AcquisitionInbox.jsx`
- `src/components/admin/OpportunityDrawer.jsx`
- `test-ui/AcquisitionInbox.test.jsx`
- `test-ui/OpportunityDrawer.test.jsx`
- `.superpowers/sdd/2026-08-30-acquisition-inbox-v1/task-6-fix-1-report.md`

## Concerns

No known correctness or scope concerns remain. No deploy, push, PR, or production action was performed.
