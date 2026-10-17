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

export function checkedP10bNativeLogObservation(value, code = null) {
  if (!value || Object.keys(value).sort().join(',') !== 'dispatched,elapsedMs,httpStatus'
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || (value.httpStatus !== null && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))
    || (code?.startsWith('bridge-') ? value.dispatched !== null || value.httpStatus !== null : typeof value.dispatched !== 'boolean')
    || (value.httpStatus !== null && value.dispatched !== true)
    || (code === null && (value.httpStatus !== 200 || value.dispatched !== true))
    || (code === 'http-failed' && (value.httpStatus === null || value.httpStatus === 200))
    || (code === 'request-denied' && (value.httpStatus !== null || value.dispatched !== false))) throw Error('Invalid public log observation');
  return { httpStatus: value.httpStatus, elapsedMs: value.elapsedMs, dispatched: value.dispatched };
}
function checkedLog(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'code,dispatched,elapsedMs,httpStatus,timeoutMs,version'
    || value.version !== 'p10b-native-log-failure-v1' || !codes.has(value.code)
    || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 5000
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0
    || (value.httpStatus !== null && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))
    || (value.code.startsWith('bridge-') ? value.dispatched !== null || value.httpStatus !== null : typeof value.dispatched !== 'boolean')
    || (value.httpStatus !== null && value.dispatched !== true)
    || (value.code === 'http-failed' && (value.httpStatus === null || value.httpStatus === 200))
    || (value.code === 'request-denied' && (value.httpStatus !== null || value.dispatched !== false))) throw Error('Invalid public log failure');
  checkedP10bNativeLogObservation({ httpStatus: value.httpStatus, elapsedMs: value.elapsedMs, dispatched: value.dispatched }, value.code);
  return { ...value };
}
export class P10bNativeLogRequestError extends Error {
  constructor(facts) {
    super('Native log request failed');
    Object.defineProperty(this, 'publicFailure', { value: Object.freeze(checkedLog({ version: 'p10b-native-log-failure-v1', ...facts })) });
  }
}
export function publicP10bNativeLogFailure(error) {
  if (!(error instanceof P10bNativeLogRequestError)) return null;
  try { return checkedLog(Object.getOwnPropertyDescriptor(error, 'publicFailure')?.value); }
  catch { return null; }
}
