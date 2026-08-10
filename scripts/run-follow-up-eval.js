import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import {
  FOLLOW_UP_EVAL_VERSION,
  FOLLOW_UP_PROMPT_VERSION,
  FOLLOW_UP_SCHEMA_VERSION,
  buildBoundedRecommendationContext,
  buildDeterministicFollowUpRecommendation,
  requestOpenAiFollowUpEnrichment,
} from '../server/services/followUpRecommendations.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..');
const defaultFixturePath = path.join(repositoryRoot, 'evals/follow-up-recommendations/fixtures.jsonl');
const defaultFaultFixturePath = path.join(repositoryRoot, 'evals/follow-up-recommendations/fault-fixtures.jsonl');
const defaultBaselinePath = path.join(repositoryRoot, 'evals/follow-up-recommendations/baseline-summary.json');

function argumentsFrom(argv) {
  const result = { candidates: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--live') result.live = true;
    else if (value === '--synthetic-only') result.syntheticOnly = true;
    else if (value === '--ack-paid-api') result.ackPaidApi = true;
    else if (value === '--fixture') result.fixturePath = argv[++index];
    else if (value === '--fault-fixture') result.faultFixturePath = argv[++index];
    else if (value === '--baseline') result.baselinePath = argv[++index];
    else if (value === '--output') result.outputPath = argv[++index];
    else if (value === '--candidate') result.candidates.push(argv[++index]);
    else throw new Error(`Unknown eval argument: ${value}`);
  }
  return result;
}

function parseJsonLines(value) {
  return value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on fixture line ${index + 1}: ${error.message}`);
      }
    });
}

function baseSubmission(fixture) {
  return {
    id: `synthetic-${fixture.id}`,
    updated_at: '2026-08-10T16:00:00.000Z',
    status: 'review',
    follow_up_state: 'needs-response',
    next_action_at: '2026-08-10T15:00:00.000Z',
    priority: 'normal',
    company: 'Synthetic Example Company',
    name: 'Case Reviewer',
    email: 'case@example.invalid',
    deal_score: 50,
    ...(fixture.submission || {}),
  };
}

function baseCommunication(fixture, communication, index) {
  return {
    id: communication.id || `${fixture.id}-communication-${index + 1}`,
    submission_id: `synthetic-${fixture.id}`,
    direction: 'inbound',
    occurred_at: new Date(Date.parse(fixture.now) - index * 60_000).toISOString(),
    subject: 'Synthetic follow-up evidence',
    body_text: '',
    from_address: 'counterparty@example.invalid',
    to_addresses: ['reviewer@example.invalid'],
    delivery_state: 'replied',
    content_state: 'complete',
    message_id: `<synthetic-${fixture.id}-${index + 1}@example.invalid>`,
    kind: 'crm-follow-up',
    ...communication,
  };
}

function buildFixtureContext(fixture) {
  const config = {
    followUp: {
      aiMaxContextChars: 30_000,
      maxTouches: 3,
      cadenceHours: [48, 72, 96],
    },
  };
  return {
    config,
    context: buildBoundedRecommendationContext({
      submission: baseSubmission(fixture),
      communications: (Array.isArray(fixture.communications) ? fixture.communications : [])
        .map((communication, index) => baseCommunication(fixture, communication, index)),
      cimRequest: fixture.cimRequest || null,
      documents: fixture.documents || [],
      suppressions: fixture.suppressions || [],
      config,
    }),
  };
}

function deterministicGrade(fixture) {
  const { config, context } = buildFixtureContext(fixture);
  const recommendation = buildDeterministicFollowUpRecommendation({
    context,
    now: new Date(fixture.now),
    config,
  });
  const suppliedIds = new Set(context.communications.map((item) => item.id).filter(Boolean));
  const failures = [];
  if (recommendation.actionType !== fixture.expected.actionType) {
    failures.push(`action:${recommendation.actionType}`);
  }
  if (recommendation.conversationState !== fixture.expected.conversationState) {
    failures.push(`state:${recommendation.conversationState}`);
  }
  if (recommendation.sendAllowed !== false) failures.push('sendAllowed');
  if (recommendation.evidenceCommunicationIds.some((id) => !suppliedIds.has(id))) failures.push('evidence');
  if (fixture.expected.noDraft && (recommendation.draftSubject || recommendation.draftBodyText)) failures.push('draft');
  if (fixture.expected.safetyFlag && !recommendation.safetyFlags.includes(fixture.expected.safetyFlag)) {
    failures.push(`safety:${fixture.expected.safetyFlag}`);
  }
  return { fixture, context, recommendation, failures };
}

function parseCandidate(value) {
  const [model, effort = 'low'] = String(value || '').split(':');
  if (!model || !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error(`Invalid candidate "${value}". Use --candidate model:reasoningEffort.`);
  }
  return { model, effort };
}

function validateCorpus(fixtures) {
  const failures = [];
  const ids = new Set();
  if (fixtures.length < 40) failures.push('The corpus must contain at least 40 cases.');
  for (const fixture of fixtures) {
    if (!fixture.id || ids.has(fixture.id)) failures.push(`Fixture IDs must be present and unique: ${fixture.id || '(missing)'}.`);
    ids.add(fixture.id);
    if (fixture.privacy !== 'synthetic') failures.push(`${fixture.id}: privacy must be synthetic.`);
    if (!['regression', 'holdout'].includes(fixture.split)) failures.push(`${fixture.id}: split must be regression or holdout.`);
    if (!Number.isFinite(Date.parse(fixture.now || ''))) failures.push(`${fixture.id}: now must be an ISO timestamp.`);
    if (!fixture.expected?.actionType || !fixture.expected?.conversationState) failures.push(`${fixture.id}: expected action/state are required.`);
    const serialized = JSON.stringify(fixture);
    const domains = serialized.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi) || [];
    if (domains.some((address) => !address.toLowerCase().endsWith('@example.invalid'))) {
      failures.push(`${fixture.id}: email fixtures must use example.invalid.`);
    }
  }
  return failures;
}

function validateFaultCorpus(fixtures) {
  const failures = [];
  const ids = new Set();
  for (const fixture of fixtures) {
    if (!fixture.id || ids.has(fixture.id)) failures.push(`Fault fixture IDs must be present and unique: ${fixture.id || '(missing)'}.`);
    ids.add(fixture.id);
    if (fixture.privacy !== 'synthetic') failures.push(`${fixture.id}: privacy must be synthetic.`);
    if (!fixture.fault || typeof fixture.expected?.used !== 'boolean') failures.push(`${fixture.id}: fault and expected outcome are required.`);
  }
  return failures;
}

function validateFrozenBaseline(baseline, { corpusSha256, fixtureCount, faultFixtureCount, splits }) {
  const failures = [];
  if (baseline.evalVersion !== FOLLOW_UP_EVAL_VERSION) failures.push('Baseline eval version does not match the runtime contract.');
  if (baseline.privacy !== 'synthetic-only') failures.push('Baseline privacy declaration must be synthetic-only.');
  if (baseline.corpusSha256 !== corpusSha256) failures.push('Frozen corpus hash differs from baseline-summary.json.');
  if (baseline.fixtureCount !== fixtureCount) failures.push('Primary fixture count differs from the frozen baseline.');
  if (baseline.faultFixtureCount !== faultFixtureCount) failures.push('Fault fixture count differs from the frozen baseline.');
  if (baseline.splits?.regression !== splits.regression || baseline.splits?.holdout !== splits.holdout) {
    failures.push('Regression/holdout split differs from the frozen baseline.');
  }
  return failures;
}

function validEnrichment(overrides = {}) {
  return {
    rationale: 'The synthetic message contains a direct question that needs a reviewed answer.',
    evidenceCommunicationIds: ['evidence-01'],
    signals: ['direct-question'],
    commitments: [],
    questions: ['Could you share more information?'],
    blockers: [],
    draftSubject: 'Re: Synthetic follow-up evidence',
    draftBodyText: 'Thank you for the question. I will review the approved facts and follow up.',
    ...overrides,
  };
}

function syntheticResponse(output, overrides = {}) {
  return {
    status: 'completed',
    model: 'synthetic-fault-model',
    output: [],
    output_text: typeof output === 'string' ? output : JSON.stringify(output),
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
    ...overrides,
  };
}

function providerError(name, status) {
  const error = new Error('Synthetic provider error body must not be retained.');
  error.name = name;
  error.status = status;
  return error;
}

function faultClient(fault) {
  return {
    responses: {
      async create() {
        if (fault === 'authentication') throw providerError('AuthenticationError', 401);
        if (fault === 'rate-limit') throw providerError('RateLimitError', 429);
        if (fault === 'timeout') throw providerError('TimeoutError');
        if (fault === 'transient') throw providerError('InternalServerError', 503);
        if (fault === 'permanent') throw providerError('BadRequestError', 400);
        if (fault === 'refusal') {
          return syntheticResponse('', {
            output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Synthetic refusal.' }] }],
          });
        }
        if (fault === 'incomplete-max-output') {
          return syntheticResponse('', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
        }
        if (fault === 'incomplete-content-filter') {
          return syntheticResponse('', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } });
        }
        if (fault === 'empty') return syntheticResponse('');
        if (fault === 'missing-returned-model') return syntheticResponse(validEnrichment(), { model: '' });
        if (fault === 'returned-model-mismatch') return syntheticResponse(validEnrichment(), { model: 'different-model' });
        if (fault === 'malformed-json') return syntheticResponse('{not-json');
        if (fault === 'schema-mismatch') return syntheticResponse({ rationale: 'Missing required fields.' });
        if (fault === 'extra-field') return syntheticResponse(validEnrichment({ unexpected: true }));
        if (fault === 'unknown-evidence') return syntheticResponse(validEnrichment({ evidenceCommunicationIds: ['evidence-99'] }));
        if (fault === 'duplicate-evidence') {
          return syntheticResponse(validEnrichment({ evidenceCommunicationIds: ['evidence-01', 'evidence-01'] }));
        }
        if (fault === 'new-recipient') return syntheticResponse(validEnrichment({ draftBodyText: 'To: invented@example.invalid' }));
        if (fault === 'new-url') return syntheticResponse(validEnrichment({ draftBodyText: 'Review https://invented.example.invalid now.' }));
        if (fault === 'attachment-claim') return syntheticResponse(validEnrichment({ draftBodyText: 'I reviewed the attached document.' }));
        if (fault === 'unsupported-date') return syntheticResponse(validEnrichment({ draftBodyText: 'I can meet Monday.' }));
        if (fault === 'failed-state') return syntheticResponse('', { status: 'failed' });
        if (fault === 'cancelled-state') return syntheticResponse('', { status: 'cancelled' });
        if (fault === 'unexpected-state') return syntheticResponse('', { status: 'queued' });
        return syntheticResponse(validEnrichment());
      },
    },
  };
}

async function adapterFaultGrade(fixture) {
  const syntheticFixture = {
    id: fixture.id,
    now: '2026-08-10T17:00:00.000Z',
    communications: [{ body_text: 'Could you share more information?' }],
  };
  const { config, context } = buildFixtureContext(syntheticFixture);
  config.followUp = {
    ...config.followUp,
    aiEnabled: true,
    aiModel: 'synthetic-fault-model',
    aiReasoningEffort: 'low',
    aiTimeoutMs: 12_000,
    aiMaxOutputTokens: 1_600,
    aiMaxRetries: 0,
  };
  const deterministic = buildDeterministicFollowUpRecommendation({
    context,
    now: new Date(syntheticFixture.now),
    config,
  });
  const result = await requestOpenAiFollowUpEnrichment({
    context,
    deterministic,
    config,
    client: faultClient(fixture.fault),
  });
  const actual = {
    used: result.used,
    fallbackReason: result.reason || null,
    responseState: result.telemetry?.responseState || null,
  };
  const passed = actual.used === fixture.expected.used
    && actual.fallbackReason === fixture.expected.fallbackReason
    && actual.responseState === fixture.expected.responseState
    && deterministic.sendAllowed === false;
  return { id: fixture.id, passed, expected: fixture.expected, actual };
}

function liveGuard(options, fixtures) {
  const failures = [];
  if (!options.syntheticOnly) failures.push('--synthetic-only is required.');
  if (!options.ackPaidApi) failures.push('--ack-paid-api is required.');
  if (!String(process.env.OPENAI_API_KEY || '').trim()) failures.push('OPENAI_API_KEY must be present.');
  if (/^(?:1|true|yes|on)$/i.test(String(process.env.FOLLOW_UP_AI_ENABLED || '').trim())) {
    failures.push('FOLLOW_UP_AI_ENABLED must remain false during the synthetic comparison.');
  }
  if (/^(?:1|true|yes|on)$/i.test(String(process.env.FOLLOW_UP_EMAIL_ENABLED || '').trim())) {
    failures.push('FOLLOW_UP_EMAIL_ENABLED must remain false during the synthetic comparison.');
  }
  if (options.candidates.length === 0) failures.push('At least one explicit --candidate model:effort is required.');
  if (fixtures.some((fixture) => fixture.privacy !== 'synthetic')) failures.push('Every live fixture must be marked synthetic.');
  return failures;
}

async function liveCandidateRun(candidate, deterministicResults) {
  const client = new OpenAI({ maxRetries: 0 });
  const cases = [];
  for (const result of deterministicResults) {
    const deterministicHardStop = ['stop_all_outreach', 'no_action'].includes(result.recommendation.actionType)
      || result.recommendation.safetyFlags.includes('outreach-blocked');
    if (deterministicHardStop) {
      cases.push({
        id: result.fixture.id,
        split: result.fixture.split,
        requested: false,
        skipReason: 'deterministic-hard-stop',
        used: false,
        fallbackReason: null,
        responseState: 'not-requested',
        returnedModel: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        leakedCanary: false,
        recommendation: null,
        hardGatePassed: result.recommendation.sendAllowed === false,
      });
      continue;
    }
    const config = {
      followUp: {
        aiEnabled: true,
        aiModel: candidate.model,
        aiReasoningEffort: candidate.effort,
        aiTimeoutMs: 12_000,
        aiMaxContextChars: 30_000,
        aiMaxOutputTokens: 1_600,
        aiMaxRetries: 0,
      },
    };
    const enrichment = await requestOpenAiFollowUpEnrichment({
      context: result.context,
      deterministic: result.recommendation,
      config,
      client,
    });
    const serializedOutput = JSON.stringify(enrichment.recommendation || {});
    const leakedCanary = (result.fixture.canaries || []).some((canary) => serializedOutput.includes(canary));
    cases.push({
      id: result.fixture.id,
      split: result.fixture.split,
      requested: true,
      skipReason: null,
      used: enrichment.used,
      fallbackReason: enrichment.reason || null,
      responseState: enrichment.telemetry?.responseState || null,
      returnedModel: enrichment.telemetry?.returnedModel || null,
      latencyMs: enrichment.telemetry?.latencyMs ?? null,
      inputTokens: enrichment.telemetry?.inputTokens ?? null,
      outputTokens: enrichment.telemetry?.outputTokens ?? null,
      cachedTokens: enrichment.telemetry?.cachedTokens ?? null,
      reasoningTokens: enrichment.telemetry?.reasoningTokens ?? null,
      leakedCanary,
      recommendation: enrichment.used ? enrichment.recommendation : null,
      hardGatePassed: enrichment.used && !leakedCanary,
    });
  }
  const requestedCases = cases.filter((item) => item.requested);
  return {
    model: candidate.model,
    reasoningEffort: candidate.effort,
    cases,
    summary: {
      requested: requestedCases.length,
      enriched: requestedCases.filter((item) => item.used).length,
      fallback: requestedCases.filter((item) => !item.used).length,
      skippedDeterministicHardStops: cases.filter((item) => !item.requested).length,
    },
    hardGatePassed: cases.every((item) => item.hardGatePassed),
    humanReview: { status: 'pending', rubric: 'grounding, usefulness, tone, concision, edit burden' },
    pricing: { status: 'not-supplied', note: 'Provide a dated official pricing input at report review; this runner does not guess prices.' },
  };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const fixturePath = path.resolve(repositoryRoot, options.fixturePath || defaultFixturePath);
  const faultFixturePath = path.resolve(repositoryRoot, options.faultFixturePath || defaultFaultFixturePath);
  const baselinePath = path.resolve(repositoryRoot, options.baselinePath || defaultBaselinePath);
  const [fixtureSource, faultFixtureSource, baselineSource] = await Promise.all([
    readFile(fixturePath, 'utf8'),
    readFile(faultFixturePath, 'utf8'),
    readFile(baselinePath, 'utf8'),
  ]);
  const fixtures = parseJsonLines(fixtureSource);
  const faultFixtures = parseJsonLines(faultFixtureSource);
  const baseline = JSON.parse(baselineSource);
  const splits = {
    regression: fixtures.filter((fixture) => fixture.split === 'regression').length,
    holdout: fixtures.filter((fixture) => fixture.split === 'holdout').length,
  };
  const corpusSha256 = createHash('sha256')
    .update(`${fixtureSource}\n--faults--\n${faultFixtureSource}`)
    .digest('hex');
  const corpusFailures = [
    ...validateCorpus(fixtures),
    ...validateFaultCorpus(faultFixtures),
    ...validateFrozenBaseline(baseline, {
      corpusSha256,
      fixtureCount: fixtures.length,
      faultFixtureCount: faultFixtures.length,
      splits,
    }),
  ];
  if (corpusFailures.length) throw new Error(corpusFailures.join('\n'));

  const deterministicResults = fixtures.map(deterministicGrade);
  const deterministicFailures = deterministicResults
    .filter((result) => result.failures.length)
    .map((result) => ({ id: result.fixture.id, failures: result.failures }));
  const adapterFaultResults = await Promise.all(faultFixtures.map(adapterFaultGrade));
  const adapterFaultFailures = adapterFaultResults.filter((result) => !result.passed);
  const report = {
    evalVersion: FOLLOW_UP_EVAL_VERSION,
    promptVersion: FOLLOW_UP_PROMPT_VERSION,
    schemaVersion: FOLLOW_UP_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    privacy: 'synthetic-only',
    corpusSha256,
    fixtureCount: fixtures.length,
    faultFixtureCount: faultFixtures.length,
    splits,
    deterministic: {
      passed: deterministicFailures.length === 0,
      passedCases: fixtures.length - deterministicFailures.length,
      failedCases: deterministicFailures,
      hardGates: {
        expectedActionAndState: deterministicFailures.length === 0,
        sendAllowedFalse: deterministicResults.every((result) => result.recommendation.sendAllowed === false),
        suppliedEvidenceOnly: deterministicResults.every((result) => !result.failures.includes('evidence')),
      },
    },
    adapterFaults: {
      passed: adapterFaultFailures.length === 0,
      passedCases: adapterFaultResults.length - adapterFaultFailures.length,
      failedCases: adapterFaultFailures,
    },
    liveComparisons: [],
  };

  if (options.live) {
    const guardFailures = liveGuard(options, fixtures);
    if (guardFailures.length) throw new Error(`Live eval refused:\n${guardFailures.join('\n')}`);
    const candidates = options.candidates.map(parseCandidate);
    for (const candidate of candidates) {
      report.liveComparisons.push(await liveCandidateRun(candidate, deterministicResults));
    }
  }

  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    const outputPath = path.resolve(repositoryRoot, options.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serializedReport, 'utf8');
  }
  process.stdout.write(serializedReport);
  if (!report.deterministic.passed || !report.adapterFaults.passed
    || report.liveComparisons.some((candidate) => !candidate.hardGatePassed)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
