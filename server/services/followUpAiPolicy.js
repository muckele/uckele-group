export const FOLLOW_UP_ENGINE_VERSION = 'follow-up-engine-v1';
export const FOLLOW_UP_RULES_VERSION = 'follow-up-rules-2026-08-09';
export const FOLLOW_UP_PROMPT_VERSION = 'follow-up-ai-prompt-v2';
export const FOLLOW_UP_SCHEMA_VERSION = 'follow-up-ai-schema-v2';
export const FOLLOW_UP_EVAL_VERSION = 'follow-up-eval-v1';

export const FOLLOW_UP_AI_REASONING_EFFORTS = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export const FOLLOW_UP_AI_RESPONSE_STATES = Object.freeze([
  'not-requested',
  'completed',
  'refused',
  'incomplete',
  'empty',
  'failed',
  'cancelled',
  'unexpected',
  'provider-error',
]);

export const FOLLOW_UP_AI_FALLBACK_REASONS = Object.freeze([
  'disabled',
  'model-not-configured',
  'context-too-large',
  'rate-cap-reached',
  'refusal',
  'incomplete-max-output',
  'incomplete-content-filter',
  'incomplete-response',
  'empty-output',
  'returned-model-mismatch',
  'invalid-json',
  'schema-validation-failed',
  'invalid-evidence',
  'duplicate-evidence',
  'unsafe-model-content',
  'provider-authentication',
  'provider-rate-limit',
  'timeout',
  'provider-transient',
  'provider-permanent',
  'response-failed',
  'response-cancelled',
  'unexpected-response-state',
  'not-requested',
]);

function text(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function buildFollowUpAiReadiness(config = {}) {
  const followUp = config.followUp || {};
  const enabled = Boolean(followUp.aiEnabled);
  const model = text(followUp.aiModel, 120);
  const reasoningEffort = text(followUp.aiReasoningEffort, 20);
  const acceptedEvalVersion = text(followUp.aiAcceptedEvalVersion, 120);
  const modelConfigured = Boolean(model);
  const apiKeyConfigured = Boolean(followUp.aiApiKeyConfigured);
  const reasoningConfigured = FOLLOW_UP_AI_REASONING_EFFORTS.includes(reasoningEffort);
  const timeoutConfigured = Number.isInteger(Number(followUp.aiTimeoutMs))
    && Number(followUp.aiTimeoutMs) >= 1_000
    && Number(followUp.aiTimeoutMs) <= 60_000;
  const contextLimitConfigured = Number.isInteger(Number(followUp.aiMaxContextChars))
    && Number(followUp.aiMaxContextChars) >= 2_000
    && Number(followUp.aiMaxContextChars) <= 100_000;
  const outputLimitConfigured = Number.isInteger(Number(followUp.aiMaxOutputTokens))
    && Number(followUp.aiMaxOutputTokens) >= 256
    && Number(followUp.aiMaxOutputTokens) <= 4_000;
  const retryLimitConfigured = Number.isInteger(Number(followUp.aiMaxRetries))
    && Number(followUp.aiMaxRetries) >= 0
    && Number(followUp.aiMaxRetries) <= 2;
  const rateLimitConfigured = Number.isInteger(Number(followUp.aiRateLimitPerMinute))
    && Number(followUp.aiRateLimitPerMinute) >= 1
    && Number(followUp.aiRateLimitPerMinute) <= 120;
  const dataHandlingApproved = Boolean(text(followUp.aiDataHandlingApprovalId, 160));
  const evalAccepted = acceptedEvalVersion === FOLLOW_UP_EVAL_VERSION;
  const costRateApproved = Boolean(text(followUp.aiCostRateApprovalId, 160));
  const syntheticSmokeObserved = Boolean(text(followUp.aiSyntheticSmokeId, 160));
  const blockers = [];

  if (!modelConfigured) blockers.push('model-not-configured');
  if (!apiKeyConfigured) blockers.push('api-key-not-configured');
  if (!reasoningConfigured) blockers.push('reasoning-effort-invalid');
  if (!timeoutConfigured) blockers.push('timeout-invalid');
  if (!contextLimitConfigured) blockers.push('context-limit-invalid');
  if (!outputLimitConfigured) blockers.push('output-token-limit-invalid');
  if (!retryLimitConfigured) blockers.push('retry-limit-invalid');
  if (!rateLimitConfigured) blockers.push('rate-limit-invalid');
  if (!dataHandlingApproved) blockers.push('data-handling-approval-missing');
  if (!evalAccepted) blockers.push('accepted-eval-version-missing');
  if (!costRateApproved) blockers.push('cost-rate-approval-missing');
  if (!syntheticSmokeObserved) blockers.push('synthetic-smoke-missing');

  return {
    enabled,
    ready: blockers.length === 0,
    blockers,
    model,
    modelConfigured,
    apiKeyConfigured,
    reasoningEffort,
    reasoningConfigured,
    timeoutMs: Number(followUp.aiTimeoutMs) || null,
    timeoutConfigured,
    maxContextCharacters: Number(followUp.aiMaxContextChars) || null,
    contextLimitConfigured,
    maxOutputTokens: Number(followUp.aiMaxOutputTokens) || null,
    outputLimitConfigured,
    maxRetries: followUp.aiMaxRetries !== null && followUp.aiMaxRetries !== undefined
      && followUp.aiMaxRetries !== '' && Number.isInteger(Number(followUp.aiMaxRetries))
      ? Number(followUp.aiMaxRetries)
      : null,
    retryLimitConfigured,
    rateLimitPerMinute: Number(followUp.aiRateLimitPerMinute) || null,
    rateLimitConfigured,
    dataHandlingApproved,
    acceptedEvalVersion,
    expectedEvalVersion: FOLLOW_UP_EVAL_VERSION,
    evalAccepted,
    costRateApproved,
    syntheticSmokeObserved,
    promptVersion: FOLLOW_UP_PROMPT_VERSION,
    schemaVersion: FOLLOW_UP_SCHEMA_VERSION,
    engineVersion: FOLLOW_UP_ENGINE_VERSION,
    rulesVersion: FOLLOW_UP_RULES_VERSION,
  };
}
