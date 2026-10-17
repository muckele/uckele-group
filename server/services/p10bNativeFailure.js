// Only closed request facts cross into public failure evidence. Never inspect
// exception messages/stacks or retain response bodies, headers or stderr.
const codes = new Set(['request-denied', 'request-failed', 'timed-out', 'http-failed', 'output-bound', 'invalid-output',
  'bridge-timeout', 'bridge-protocol', 'bridge-failed']);
function checked(value) {
  if (!value || Object.keys(value).some(k => !['version', 'code', 'method', 'timeoutMs'].includes(k))
    || value.version !== 'p10b-native-request-failure-v1' || !codes.has(value.code)
    || !['GET', 'POST', 'WAIT'].includes(value.method) || !Number.isInteger(value.timeoutMs)
    || value.timeoutMs < 1 || value.timeoutMs > 10000) {
    throw Error('Invalid public native failure');
  }
  return { version: value.version, code: value.code, method: value.method, timeoutMs: value.timeoutMs };
}
export class P10bNativeRequestError extends Error {
  constructor(facts) {
    super('Native request failed');
    Object.defineProperty(this, 'publicFailure', { value: Object.freeze(checked({ version: 'p10b-native-request-failure-v1', ...facts })) });
  }
}
export function publicP10bNativeFailure(error) {
  if (!(error instanceof P10bNativeRequestError)) return null;
  try { return checked(Object.getOwnPropertyDescriptor(error, 'publicFailure')?.value); }
  catch { return null; }
}
