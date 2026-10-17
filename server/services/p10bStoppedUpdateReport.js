// Public diagnostics only. This report grants no action and never serializes errors.
const steps = new Set(['entry-validation', 'recovery-native-initialization', 'recovery-baseline-read',
  'recovery-native-reap', 'recovery-independent-baseline', 'recovery-archive', 'recovery-independent-archive',
  'stopped-update-diagnostic', 'native-initialization', 'before-observation', 'diagnostic-write',
  'diagnostic-settlement', 'conditional-restoration', 'restoration-settlement', 'mutation-settlement-unverified',
  'diagnostic-request-failed', 'native-reap-unverified', 'local-client-reap', 'private-auth-cleanup']);
export function p10bStoppedUpdateReport({ sessionDigest = null, success = false, failedStep = 'entry-validation',
  failure = null, lastObservation = null, mutationUncertain = false, restored = false,
  clientsClosed = false, privateCleanup = 'not-yet-checked' } = {}) {
  // failure is constructed only by the closed request contract/controller; project
  // the fixed primitive fields, never error.message, response bodies or headers.
  const httpStatus = Number.isInteger(failure?.observation?.httpStatus) && failure.observation.httpStatus >= 100
    && failure.observation.httpStatus <= 599 ? failure.observation.httpStatus : null;
  const requestMethod = ['GET', 'POST', 'WAIT'].includes(failure?.method) ? failure.method : null;
  let category = success ? 'none' : 'validation-or-unclassified';
  if (failure?.code === 'timed-out') category = 'timeout';
  else if ([401, 403].includes(httpStatus)) category = 'authentication-or-authorization';
  else if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) category = 'http-rejection';
  else if (failure) category = 'request-failure';
  if (failedStep === 'private-auth-cleanup') category = 'cleanup-unverified';
  if (failedStep === 'local-client-reap' || failedStep === 'native-reap-unverified') category = 'client-closure-unverified';
  const observation = lastObservation && ['baseline', 'diagnostic'].includes(lastObservation.configurationRole)
    && ['stopped', 'created', 'replacing'].includes(lastObservation.state)
    && typeof lastObservation.at === 'string' && new Date(lastObservation.at).toISOString() === lastObservation.at ? lastObservation : null;
  return {
    version: 'p10b-stopped-update-operator-report-v1',
    sessionDigest: /^[a-f0-9]{64}$/.test(sessionDigest || '') ? sessionDigest : null,
    outcome: success ? 'succeeded' : 'held', failedStep: success ? null : (steps.has(failedStep) ? failedStep : 'entry-validation'),
    category, httpStatus, requestMethod,
    dispatched: typeof failure?.observation?.dispatched === 'boolean' ? failure.observation.dispatched : null,
    serverState: mutationUncertain ? 'uncertain-after-request' : !observation ? 'unverified'
      : observation.state === 'replacing' ? 'last-observed-replacing' : `last-observed-${observation.configurationRole}-nonrunning`,
    lastObservedAt: observation?.at ?? null, restorationVerified: restored === true, clientsClosed: clientsClosed === true,
    privateCleanup: ['verified', 'unverified'].includes(privateCleanup) ? privateCleanup : 'not-yet-checked',
    localClosureIssue: !clientsClosed ? 'clients-unverified' : privateCleanup === 'unverified' ? 'private-cleanup-unverified' : null,
    nextAction: success ? 'manually-revoke-matching-token-after-closed-clients'
      : !clientsClosed || privateCleanup === 'unverified' ? 'separately-approved-incident-handling' : 'preserve-for-independent-review',
    automaticRetryAllowed: false, automaticRecoveryAllowed: false, newCredentialAuthorized: false,
    productionReady: false, globalAutomationPaused: true, providerCalls: 0, emails: 0,
  };
}
export class P10bStoppedUpdateCliHold extends Error {
  constructor(operatorReport) {
    super('Stopped-update diagnostic held; preserve evidence');
    Object.defineProperty(this, 'operatorReport', { value: Object.freeze(operatorReport) });
  }
}
