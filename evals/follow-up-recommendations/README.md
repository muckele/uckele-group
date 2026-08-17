# Follow-up recommendation evaluation

This evaluation is a versioned, synthetic-only release gate for the deterministic recommendation engine and optional OpenAI enrichment adapter. It is not authorization to use real CRM content, enable either production feature flag, or incur paid API usage.

## Corpus and offline gate

`fixtures.jsonl` contains 51 sanitized cases: 40 regression cases and 11 holdout cases. `fault-fixtures.jsonl` adds 24 credential-free adapter scenarios for success, refusal, incomplete/empty/malformed output, returned-model enforcement, schema and evidence violations, unsafe content, provider failures, and response-state handling. Every case is marked `privacy: synthetic`, every email address must end in `@example.invalid`, and the runner rejects a primary corpus with fewer than 40 cases. The corpus covers normal follow-up states, suppression and lifecycle hard stops, delivery boundaries, malformed history, multilingual and Unicode content, duplicate identifiers, prompt injection, secret/address/URL/header canaries, filenames, listing URLs, and internal identifiers.

Run the credential-free gate with:

```bash
npm run eval:follow-ups
```

This command makes no model request. It grades the exact deterministic action and conversation state, verifies `sendAllowed === false`, verifies that evidence IDs came from supplied context, checks no-draft and safety-flag expectations where specified, and runs the 24 fake-client response/fault contracts. `baseline-summary.json` records the accepted offline baseline for `follow-up-eval-v1`, including the frozen primary-plus-fault corpus SHA-256; the runner refuses corpus, count, split, privacy, or version drift until the baseline is deliberately reviewed and updated. Runner output also includes the current prompt and schema versions. Context-race, application rate-cap, simultaneous refresh, and stale-write behavior use the storage-backed unit/integration suite because those cases require the full recommendation orchestration rather than the provider adapter alone.

Any fixture or deterministic-grader failure blocks release. Update fixtures deliberately when policy changes, review holdout impacts separately, and change `FOLLOW_UP_EVAL_VERSION` when the accepted corpus contract changes.

## Guarded live synthetic comparison

Live evaluation is a separate paid operation. It is refused unless all of these controls are present:

- the explicit `--live`, `--synthetic-only`, and `--ack-paid-api` arguments;
- at least one explicit `--candidate model:reasoningEffort` argument;
- an approved `OPENAI_API_KEY` supplied through the normal secret process;
- `FOLLOW_UP_AI_ENABLED` and `FOLLOW_UP_EMAIL_ENABLED` both unset or false; and
- a corpus in which every case is marked synthetic.

After privacy, API-project, and paid-call approval, compare the initial candidates with:

```bash
npm run eval:follow-ups:live -- \
  --synthetic-only \
  --ack-paid-api \
  --candidate gpt-5.6-terra:low \
  --candidate gpt-5.6-sol:low \
  --output evals/follow-up-recommendations/reports/approved-comparison.json
```

The report directory is ignored by Git because a live report contains the generated synthetic enrichment/draft text and operational measurements that require review before publication. The runner does not send deterministic hard-stop cases to the model. For eligible cases, a fallback, refusal, incomplete result, schema failure, unsafe output, unknown/duplicate evidence ID, or canary leak fails that candidate's hard gate even though the runtime would safely fall back to deterministic advice. The report records the configured candidate, exact returned model, response state, fallback category, generated synthetic recommendation, latency, and input/output/cached/reasoning token counts. It does not guess prices; add a dated official pricing input during review. A review coordinator must copy the generated recommendations into a separately randomized packet with candidate identity removed before giving it to blinded reviewers; do not ask reviewers to score directly from the model-labeled operational report.

## Acceptance and human review

A model/effort candidate can be accepted only when:

1. every automatic hard gate passes;
2. the exact returned model matches the explicit configured candidate and is permitted by the recorded model approval (if a candidate alias resolves differently, record the returned ID and rerun with that exact approved ID);
3. blinded reviewers mark at least 90% of eligible cases usable as-is or with minor edits;
4. no case weakens or contradicts the deterministic action, blocker, timing, or safety outcome;
5. measured latency, token use, request rate, and dated cost estimate fit the approved operating envelope; and
6. the holdout results meet the same criteria as the regression split.

Reviewers should score each eligible output without seeing the model name. Use a 1–5 scale for grounding, usefulness, professional tone, concision, and edit burden, and record any fabricated claim, unsupported commitment, unsafe attachment/document statement, instruction-following from quoted evidence, or recipient/header implication as a hard failure. Adjudicate disagreements and preserve only sanitized aggregate findings in the accepted report.

Start with `gpt-5.6-terra` at `low` reasoning and `gpt-5.6-sol` at `low`. Test `medium` only if low effort misses a material quality target. Choose the least costly candidate that clears every quality, safety, latency, and governance gate; do not select a model from documentation claims alone.

## Controlled smoke and acceptance record

After a candidate is accepted, run the same guarded command against the frozen corpus from the approved OpenAI project while both application flags remain off. Confirm the exact returned model, strict schema success, no redaction canary, aggregate latency/tokens, and a deliberately induced safe fallback in the adapter tests. Record a non-secret smoke evidence identifier in `FOLLOW_UP_AI_SYNTHETIC_SMOKE_ID`, the accepted corpus version in `FOLLOW_UP_AI_ACCEPTED_EVAL_VERSION`, and the separate approval identifiers described in the operations runbook. A smoke ID is evidence of a reviewed synthetic run, not a substitute for privacy, cost/rate, or model approval.
