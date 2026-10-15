import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createP10bAppTokenContext } from '../server/services/p10bHostAuthentication.js';
import * as nativeClient from '../server/services/p10bNativeMachineClient.js';
import { stoppedDiagnosticFixture, diagnosticDigest as digest } from './helpers/p10bStoppedDiagnosticFixture.js';
const contract = await import('../server/services/p10bStoppedUpdateContract.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
const operator = await import('../server/services/p10bStoppedUpdateDiagnostic.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error;
});
function evidenceStore() {
  const records = new Map();
  return { records, has: name => records.has(name), write(name, value) {
    assert.equal(records.has(name), false); records.set(name, structuredClone(value));
  } };
}
function fakeBoundary(session, mode, advance) {
  let config = session.baselineConfig; let version = session.baselineInstanceId; let writes = 0; let reads = 0;
  const calls = [];
  return { calls, async client(method = 'GET', body, timeoutMs) {
    calls.push({ method, body, timeoutMs });
    if (method === 'POST') {
      writes++; assert.equal(body.skip_launch, true); assert.equal(body.current_version, version);
      if (writes === 1 && mode !== 'success') {
        throw new contract.P10bStoppedUpdateRequestError({ code: 'timed-out', method, timeoutMs,
          observation: { httpStatus: null, elapsedMs: 10000, dispatched: true } });
      }
      config = body.config; version = `new-version-${writes}`;
    } else {
      reads++;
      if (mode === 'late-acceptance' && writes === 1 && reads === 4) { config = session.diagnosticConfig; version = 'accepted-after-timeout'; }
    }
    advance(1);
    return { machine: { id: session.machineId, state: 'stopped', region: 'ewr', instance_id: version,
      config: structuredClone(config), image_ref: { digest: config.image.split('@')[1] } },
      observation: { httpStatus: 200, elapsedMs: 1, dispatched: true } };
  }, async reap() { calls.push({ reaped: true }); return true; } };
}
test('stopped-only contract admits exact zero-start consent and the complete frozen diagnostic config', () => {
  assert.equal(typeof contract.assertP10bStoppedUpdateApproval, 'function', 'separate stopped-only contract required');
  const { session, approval } = stoppedDiagnosticFixture();
  assert.equal(contract.assertP10bStoppedUpdateApproval(session, approval, Date.now()), true);
  assert.deepEqual(contract.createP10bStoppedDiagnosticConfig(session), session.diagnosticConfig);
});
for (const mode of ['success', 'timeout-baseline-only', 'late-acceptance']) {
  test(`stopped-only controller preserves mutation outcome without starts or retries: ${mode}`, async () => {
    assert.equal(typeof operator.runP10bStoppedUpdateDiagnostic, 'function');
    let now = Date.now(); const { session, approval } = stoppedDiagnosticFixture(now);
    const evidence = evidenceStore(); const native = fakeBoundary(session, mode, ms => { now += ms; });
    const result = await operator.runP10bStoppedUpdateDiagnostic({ session, approval, evidence,
      createClient: async () => native, assertAdmission: () => true, clock: () => now,
      wait: async ms => { now += ms; } });
    const posts = native.calls.filter(c => c.method === 'POST');
    assert.equal(posts.length, mode === 'timeout-baseline-only' ? 1 : 2);
    assert.equal(posts[0].timeoutMs, 10000); assert.deepEqual(posts[0].body.config, session.diagnosticConfig);
    if (posts.length === 2) assert.deepEqual(posts[1].body.config, session.baselineConfig);
    assert.equal(result.restored, mode !== 'timeout-baseline-only');
    assert.equal(result.mutationUncertain, mode === 'timeout-baseline-only');
    assert.equal(result.nativeReapVerified, true);
    assert.equal(result.primary.code, mode === 'success' ? null : 'timed-out');
    assert.equal(result.success, mode === 'success');
    assert.equal([...evidence.records.keys()].some(name => /start|qualification/.test(name)), false);
    await assert.rejects(operator.runP10bStoppedUpdateDiagnostic({ session, approval, evidence,
      createClient: async () => { throw Error('must not reopen'); }, assertAdmission: () => true, clock: () => now }));
  });
}
test('stopped-only consent rejects qualification, starts, retry, wrong targets and rehashed config drift', () => {
  assert.equal(typeof contract.assertP10bStoppedUpdateApproval, 'function');
  for (const change of [s => { s.version = 'p10b-no-email-session-v1'; }, s => { s.maximumStarts = 1; },
    s => { s.maximumDiagnosticPosts = 2; }, s => { s.maximumRestorationPosts = 2; }, s => { s.requestTimeoutMs = 1000; },
    s => { s.machineId = 'wrong-machine'; }, s => { s.diagnosticConfig.services[0].autostart = true; },
    s => { s.diagnosticConfig.env.DEAL_HUNTER_CIM_PROVIDER_ENABLED = 'true'; },
    s => { s.diagnosticConfig.processes[0].exec = ['node', 'server/index.js']; }]) {
    const { session, approval } = stoppedDiagnosticFixture(); change(session);
    session.diagnosticConfigDigest = digest(session.diagnosticConfig); approval.sessionDigest = digest(session);
    assert.throws(() => contract.assertP10bStoppedUpdateApproval(session, approval, Date.now()));
  }
  const { session, approval } = stoppedDiagnosticFixture(); approval.version = 'p10b-no-email-approval-v1';
  assert.throws(() => contract.assertP10bStoppedUpdateApproval(session, approval, Date.now()));
});
test('diagnostic failures retain only typed status/elapsed/dispatch facts', () => {
  assert.equal(typeof contract.P10bStoppedUpdateRequestError, 'function');
  const facts = { code: 'http-failed', method: 'POST', timeoutMs: 10000,
    observation: { httpStatus: 422, elapsedMs: 3, dispatched: true } };
  const error = new contract.P10bStoppedUpdateRequestError(facts);
  error.message = 'private-error-canary'; error.stack = 'private-stack-canary';
  assert.deepEqual(contract.publicP10bStoppedUpdateFailure(error), facts);
  assert.equal(contract.publicP10bStoppedUpdateFailure(Object.assign(Error('canary'), { publicFailure: facts })), null);
  for (const observation of [{ ...facts.observation, httpStatus: '422' }, { ...facts.observation, rawBody: 'canary' },
    { ...facts.observation, httpStatus: 200 }, { ...facts.observation, elapsedMs: -1 }, { ...facts.observation, dispatched: false }]) {
    assert.throws(() => new contract.P10bStoppedUpdateRequestError({ ...facts, observation }));
  }
});
test('diagnostic credential context requires its exact consent and preserves private cleanup gates', () => {
  const { session, approval } = stoppedDiagnosticFixture();
  const context = createP10bAppTokenContext({ session, approval,
    environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', FLY_API_TOKEN: 'synthetic-diagnostic-private-canary' } });
  const directory = context.environment.FLY_CONFIG_DIR;
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(context).includes('canary'), false);
  assert.throws(() => context.cleanup({ reaped: false }));
  assert.equal(context.cleanup({ reaped: true }), true); assert.equal(fs.existsSync(directory), false);
  assert.throws(() => createP10bAppTokenContext({ session, approval: { ...approval, version: 'p10b-no-email-approval-v1' } }));
});
test('operation-specific native bridge rejects wider consent before constructing a child', async () => {
  assert.equal(typeof nativeClient.openP10bStoppedUpdateClient, 'function');
  const { session, approval } = stoppedDiagnosticFixture();
  await assert.rejects(nativeClient.openP10bStoppedUpdateClient({ session: { ...session, maximumStarts: 2 }, approval,
    spawnProcess: () => { throw Error('must not construct'); } }));
  await assert.rejects(nativeClient.openP10bNativeMachineClient({ session, approval,
    spawnProcess: () => { throw Error('must not construct'); } }));
});
test('withdrawn admission after client creation blocks reads and writes and still reaps', async () => {
  const { session, approval } = stoppedDiagnosticFixture(); const evidence = evidenceStore();
  let checks = 0; const native = fakeBoundary(session, 'success', () => {});
  const result = await operator.runP10bStoppedUpdateDiagnostic({ session, approval, evidence,
    assertAdmission: () => ++checks === 1, createClient: async () => native });
  assert.equal(result.success, false); assert.equal(result.failureStage, 'before-observation');
  assert.equal(native.calls.some(c => c.method), false); assert.equal(result.nativeReapVerified, true);
});
test('a candidate arriving after the observation cutoff cannot authorize restoration', async () => {
  let now = Date.now(); const start = now; const { session, approval } = stoppedDiagnosticFixture(now);
  const evidence = evidenceStore(); let reads = 0; let posts = 0; const timeouts = [];
  const response = (candidate, version) => ({ machine: { id: session.machineId, region: 'ewr', state: 'stopped',
    instance_id: version, config: candidate ? session.diagnosticConfig : session.baselineConfig,
    image_ref: { digest: candidate ? session.candidateImageDigest : session.baselineImageDigest } },
    observation: { httpStatus: 200, elapsedMs: 0, dispatched: true } });
  const native = { async client(method, body, timeoutMs) {
    if (method === 'POST') { posts++; return response(true, 'candidate-version'); }
    timeouts.push(timeoutMs); reads++;
    if (reads <= 2) return response(false, session.baselineInstanceId);
    now += 10; return response(true, 'candidate-version');
  }, async reap() { return true; } };
  const result = await operator.runP10bStoppedUpdateDiagnostic({ session, approval, evidence,
    createClient: async () => native, assertAdmission: () => true, clock: () => now,
    wait: async ms => { now = Math.max(now + ms, start + 9995); } });
  assert.equal(posts, 1); assert.equal(timeouts.at(-1), 5);
  assert.equal(result.restored, false); assert.equal(result.mutationUncertain, true);
});
test('admission withdrawn during durable intent blocks dispatch', async () => {
  const { session, approval } = stoppedDiagnosticFixture(); const evidence = evidenceStore();
  let admitted = true; const write = evidence.write.bind(evidence);
  evidence.write = (name, value) => { write(name, value); if (name.endsWith('-diagnostic-intent.json')) admitted = false; };
  const native = fakeBoundary(session, 'success', () => {});
  const result = await operator.runP10bStoppedUpdateDiagnostic({ session, approval, evidence,
    createClient: async () => native, assertAdmission: () => admitted });
  assert.equal(native.calls.filter(c => c.method === 'POST').length, 0); assert.equal(result.success, false);
});
test('rehashed baseline cannot enable providers, automation or change the frozen sender', () => {
  for (const [name, value] of [['DEAL_HUNTER_CIM_PROVIDER_ENABLED', 'true'], ['DEAL_HUNTER_CIM_AUTOMATION_PAUSED', 'false'],
    ['DELIVERY_PROVIDER', 'resend'], ['DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL', 'Other <other@example.com>']]) {
    const { session, approval } = stoppedDiagnosticFixture(); session.baselineConfig.env[name] = value;
    session.diagnosticConfig = contract.createP10bStoppedDiagnosticConfig(session);
    session.diagnosticConfigDigest = digest(session.diagnosticConfig); approval.sessionDigest = digest(session);
    assert.throws(() => contract.assertP10bStoppedUpdateApproval(session, approval));
  }
});
test('diagnostic recovery metadata rejects hidden fields and malformed public bindings', () => {
  for (const recovery of [{ rawToken: 'canary' }, { packetDigest: 'bad' }]) {
    const { session, approval } = stoppedDiagnosticFixture(); session.recovery = recovery; approval.sessionDigest = digest(session);
    assert.throws(() => contract.assertP10bStoppedUpdateApproval(session, approval));
  }
});
