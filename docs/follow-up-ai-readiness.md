# Optional AI hardening and rollout evidence

Prepared and re-checked: 2026-08-10

This document is the implementation evidence and blocker ledger for optional OpenAI enrichment in the CRM Follow-ups Workspace. It does not authorize enabling AI, processing real CRM data with a model, running a paid model evaluation, enabling generic CRM email, applying a production migration, or releasing code.

## Baseline requirement matrix

| Requirement | Current evidence before this hardening pass | Gap | Risk | Planned fix or test | Baseline status |
| --- | --- | --- | --- | --- | --- |
| Deterministic, credential-free baseline | `buildDeterministicFollowUpRecommendation`; focused recommendation tests pass without a client or key | Boundary corpus is narrower than the operating prompt | Missed edge state could produce poor decision support | Add representative synthetic fixtures and deterministic graders | Present; expand tests |
| Deterministic safety authority and no-send | AI merge retains deterministic action and `sendAllowed: false`; admin generation route does not call email services | AI output redundantly requests `intent` and `actionType` | Duplicated authority and unnecessary tokens | Remove policy fields from the AI output schema and prove action preservation | Present; minimize contract |
| Minimized model input | Context is bounded to 30,000 characters | The projection includes addresses, RFC headers/IDs, listing URLs, filenames, document names, and internal IDs | Unnecessary CRM disclosure | Add a dedicated redacting projection and serialized-request leak tests | Gap |
| Explicit Responses controls | `store: false`, `tools: []`, strict JSON Schema, Zod, timeout, output-token cap | Reasoning and retries are implicit; output cap is hard-coded | Latency and spend drift | Configure and validate effort, token cap, retries, timeout, and rate cap; include them in fingerprints | Partial |
| Explicit provider response handling | Invalid JSON/schema/evidence and timeout/provider error fall back | Refusal, incomplete, empty, auth, rate-limit, and response status are not separately countable | Poor diagnosis and rollout evidence | Add a bounded reason enum, response-state parsing, fault tests, and redacted telemetry | Gap |
| Duplicate-spend protection | Persisted unique fingerprint and current-row constraints deduplicate storage | Concurrent identical in-process requests can both call the provider | Duplicate spend | Add fingerprint single-flight and a simultaneous-request test | Gap |
| Context race protection | Context is reloaded and fingerprinted after the model call; changes return 409 | No regression needed | Stale advice | Preserve and extend concurrency tests | Present |
| Readiness gates | Feature flag, model, and API-key presence are shown | No data-handling approval, accepted eval, cost/rate approval, or synthetic smoke evidence | Accidental enablement before governance is complete | Add fail-closed config validation, readiness fields, and UI states | Gap |
| Privacy-safe telemetry | Recommendation metadata records AI requested/used/fallback; Operations returns counts | No response state, latency, usage tokens, versions, exact returned model, or per-reason fallbacks | Cannot evaluate quality/latency/cost safely | Persist bounded numeric/enumerated metadata and expose count-only aggregates | Gap |
| Honest UI provenance | Degraded fallback is visible | Successful enrichment and deterministic-only results are unlabeled; confidence looks probabilistic | Misleading decision support | Label all provenance states and remove the percentage presentation | Gap |
| Reproducible evaluation | Unit fixtures cover important safety paths | No dedicated 40+ case sanitized corpus, runner, graders, or guarded live comparison | Model choice cannot be evidence-based | Add offline evals plus an opt-in synthetic-only live comparator | Gap |
| Disabled-by-default rollout | `.env.example` sets AI and generic email flags false | External approvals and live evidence are absent | Rollout blocker could be mistaken for completion | Keep flags off and maintain the blocker ledger below | Present; externally blocked |

## Implementation resolution

Repository hardening was implemented and locally rechecked on 2026-08-10 without a live model call or production configuration change:

| Area | Resolution and evidence | Status |
| --- | --- | --- |
| Deterministic baseline | The versioned synthetic gate passes 51/51 cases across 40 regression and 11 holdout fixtures. Storage-backed tests cover time boundaries, legacy/malformed data, duplicate IDs, cache expiry, concurrent refresh, and context races. | Code gate passed |
| AI authority | The strict model schema contains enrichment fields only. Deterministic action, intent, priority/timing, hard stops, blockers/safety, confidence, recipients, and `sendAllowed: false` are not model-controlled. Hard stops skip the provider request. | Code gate passed |
| Minimized input | A dedicated serialized projection uses opaque evidence labels and excludes addresses, raw RFC IDs/headers, URLs, filenames, document names/IDs, attachment IDs/MIME types/contents, suppression details, and internal CRM/CIM IDs. Recognizable leak canaries are asserted absent. | Code gate passed |
| Responses controls | The adapter explicitly sets model, `store: false`, `tools: []`, reasoning effort, strict JSON Schema, output cap, timeout, and per-request retries. Startup validates bounded settings and fingerprints include result-changing controls and contract versions. | Code gate passed |
| Failure contract | Twenty-four offline fake-client evals plus focused unit tests cover complete output, refusal, incomplete/content-filter/max-output, empty/malformed/schema-invalid output, missing/mismatched returned model, evidence violations, unsafe content, auth, provider rate limit, timeout, transient/permanent errors, and failed/cancelled/unexpected states. Every failure has a bounded category and deterministic runtime fallback. | Code gate passed |
| Duplicate/stale protection | Same-process requests for an identical storage/submission/fingerprint share one provider call. A generation sequence prevents a slower older, different fingerprint from replacing a newer request, and the post-model context reload/fingerprint guard returns a conflict rather than storing changed-context advice. Production is documented as a single application machine while SQLite is in use. | Code gate passed for current topology |
| Readiness gates | Model/key presence, reasoning/bounds, data-handling approval, exact accepted eval version, cost/rate approval, and synthetic-smoke evidence are independent fail-closed gates. API-key value is never returned. | Code gate passed; external gates open |
| Telemetry | Persisted metadata is bounded to versions/provenance/model IDs/state/reason/latency/characters/tokens/cache/single-flight outcomes. SQLite and Supabase expose count-only aggregates; missing observations remain null/`Not observed`. | Code gate passed |
| UX | Recommendation provenance now distinguishes deterministic, enriched/human-review-required, and degraded deterministic fallback. The prior probability-like percentage presentation is removed. Operations separates deterministic availability from each optional-AI readiness gate. | Code gate passed |
| Evaluation | `follow-up-eval-v1` contains 51 synthetic decision cases plus 24 fake-client adapter cases. The guarded live runner requires explicit synthetic/paid acknowledgements, explicit candidates, a key, and both production flags false. | Offline gate passed; paid comparison not authorized/not run |

The code path is prepared for a disabled rollout review, but optional AI is not approved for production use. No exact production model can be selected until the live synthetic comparison, blind human quality review, exact-returned-model check, measured latency/token evidence, dated cost calculation, privacy/data-handling approval, cost/rate approval, and controlled smoke all exist. Deterministic Recommendations remain the releaseable credential-free capability.

## Official OpenAI research record

Research date: 2026-08-10. The latest-model resolver could not reach the network twice from the shell, so the same official documents were fetched through the OpenAI developer-docs service.

- [Current model guidance](https://developers.openai.com/api/docs/guides/latest-model.md) identifies `gpt-5.6-sol` as the flagship target, `gpt-5.6-terra` as the balanced candidate, and `gpt-5.6-luna` as the efficient high-volume candidate. The mutable `gpt-5.6` alias routes to Sol, so an approved deployment should use an evaluated explicit model ID.
- [GPT-5.6 migration guidance](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol.md) warns that omitted GPT-5.6 reasoning defaults to `medium` and recommends comparing representative workloads at an explicit baseline and a lower effort.
- [GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md) recommends lean, outcome-focused instructions with explicit constraints and output contracts.
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) documents strict JSON Schema output and programmatically detectable refusals. Application-side validation remains required for business constraints and evidence grounding.
- [Responses and reasoning](https://developers.openai.com/api/docs/guides/reasoning) documents `reasoning.effort` and that `max_output_tokens` includes visible and reasoning tokens.
- [Data controls](https://developers.openai.com/api/docs/guides/your-data#v1responses) distinguishes request storage settings from organization/project retention controls. `store: false` is not evidence of Zero Data Retention or contractual approval.
- [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) recommends representative typical, edge, and adversarial cases, held-out evaluation, explicit criteria, and human review for subjective quality.

Installed contract inspected locally: `openai@7.4.0`. Its Responses types support `reasoning.effort`, `max_output_tokens`, response `status`, `incomplete_details`, refusal content, exact returned `model`, usage token breakdowns, request `timeout`, and per-request `maxRetries`. The SDK default is two retries; this adapter must override it deliberately.

## Initial model/eval decision

No paid live model run or real-CRM evaluation is authorized in this task. The bounded starting comparison is therefore `gpt-5.6-terra` at `low` reasoning versus `gpt-5.6-sol` at `low` reasoning, using the same frozen synthetic corpus, request shape, schema, and graders. `medium` effort is a follow-up candidate only if low effort misses a material quality target. No model is accepted for production until the live synthetic comparison and blinded human rubric are completed. The runtime model remains unset and optional AI remains disabled. The accepted offline artifact currently records 51/51 deterministic cases and 24/24 adapter response/fault cases passing; it contains no live quality, latency, token, or cost measurement.

## Blocker ledger

| Class | Blocker | Owner | Evidence required | Exact next action |
| --- | --- | --- | --- | --- |
| External approval | CRM data handling, privacy, retention, and contract review is not documented | Privacy/security owner | Approval record covering the chosen OpenAI organization/project, permitted CRM fields, retention controls, and explicit acknowledgement that `store: false` is not ZDR | Complete the review and configure its non-secret approval identifier; do not enable AI before it exists |
| Configuration | Approved API project/key and exact selected-model availability are not established | OpenAI project owner | Key presence in the approved project and a synthetic call returning the selected exact model ID | Configure through the normal secret process only after approval; never print the key |
| Evaluation | No authorized live comparison or blinded human review has been completed | Product owner and reviewers | Accepted eval version; hard-gate report; at least 90% usable-with-minor-edits result; latency/token evidence | Run the guarded synthetic-only comparison under separate paid-call authorization, then conduct blind review |
| External approval | Cost, rate, and latency envelope is not approved | Finance/operations owner | Approved request-rate cap, budget envelope, and acceptable measured latency | Record the approval identifier and bounds; keep AI disabled if no target is approved |
| External service | Controlled synthetic smoke has not been authorized or observed | Release owner | Synthetic-only smoke ID with returned model, schema result, token usage, latency, and fallback test | Authorize and run the documented smoke sequence while both production feature flags remain off |
| External approval | Rollback owner and decision on whether real CRM content is ever permitted are unresolved | Operations/privacy owner | Named owner, disable/rotation procedure, and explicit real-data decision | Record the decision before any canary |

Airtable is retired from Deal Hunter source collection and health. The separate, freshness-gated Deal OS CSV/XLSX import remains supplemental during the Google Sheets transition; neither source decision changes any optional-AI approval or enablement requirement.

## Local verification record

Verification was run on 2026-08-10 with the bundled Node.js 24 runtime. It is evidence for the repository changes only; it is not evidence that a production migration, production configuration, provider account, real CRM data path, or deployment has been exercised.

| Gate | Result | Scope and limitations |
| --- | --- | --- |
| `npm run check` | Passed | Frozen offline eval 51/51 deterministic and 24/24 adapter-fault cases; ESLint with zero warnings; backend 358/358; UI 85/85 across 18 files; Vite production build; metadata pre-render for 9 public routes |
| `npm run test:browser` | Passed 6/6 | Chromium coverage includes public navigation/focus, unauthenticated fail-closed entry points, keyboard-accessible overview links, CRM URL state, Operations, and the authenticated Follow-ups queue at 390×844 with modal focus restoration and safe display of untrusted email text. API routes are synthetic browser fixtures, not a real CRM or provider. |
| Focused privacy/config/live-guard/recommendation suite | Passed 73/73 | Deterministic policy, serialized AI projection and credential canaries, Responses contract, returned-model enforcement, failure mapping, evidence validation, cache/single-flight/race behavior, application rate cap, strict environment parsing, and pre-network live-eval guards |
| Live-eval negative guard | Refused before a provider call | Running the live entry point without `--synthetic-only`, `--ack-paid-api`, an API key, and an explicit candidate stops locally; no OpenAI request was made |
| Diff validation | Passed | `git diff --check`; no stale minimum-confidence gate or previous adapter-fixture count references found |
| `npm audit --omit=dev` | Passed | npm reported zero known production-dependency vulnerabilities; no dependency or lockfile change was made in this hardening pass |

The hardening and evaluation run summarized above made no OpenAI API call, used no real CRM evaluation, sent no outbound email, applied no production migration, and enabled no feature flag. Commit, push, and deployment are separate release actions and are not evidence that the optional-AI rollout gates have been approved. The additive Supabase migration remains relevant only to a Supabase release; the current Fly topology uses SQLite startup migrations. Both optional-AI and generic-email example flags remain false.
