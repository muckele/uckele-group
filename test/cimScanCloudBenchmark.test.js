import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CIM_SCAN_CLOUD_BENCHMARK_SCENARIOS,
  CimScanBenchmarkAbruptExitObservedError,
  createEicarTestBytes,
  runCimScanCloudBenchmarkScenario,
} from '../server/services/cimScanCloudBenchmark.js';
import { ScannerReplayConflictError } from '../server/services/flyMachineOperabilityAdapters.js';
import { ScannerWorkerDeadlineError } from '../server/services/nodePinnedHttpsExchange.js';

const expectedScenarios = Object.freeze([
  'cold-clean-1k',
  'warm-clean-1k',
  'cold-clean-8m',
  'warm-clean-8m',
  'eicar-unsafe',
  'stale-signatures',
  'replay-conflict',
  'timeout-cleanup-owned-stop',
]);

function uuids() {
  let next = 1;
  return () => `${String(next++).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

async function consume(job) {
  let bytes = 0;
  for await (const chunk of job.openByteStream()) bytes += chunk.length;
  return bytes;
}

function result(outcome, reasonCode, requestDigest = 'a'.repeat(64), cleanupStatus = 'cleaned') {
  return Object.freeze({
    outcome,
    reasonCode,
    engineVersion: '1.synthetic',
    signatureVersion: 'db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
    scannedAt: '2026-10-03T12:00:01.000Z',
    protocolResultExpiresAt: '2026-10-03T12:02:00.000Z',
    requestDigest,
    cleanupStatus,
  });
}

function options(overrides = {}) {
  return {
    jobOwner: 'synthetic-cloud-caller',
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    createUuid: uuids(),
    ownedStopVerifier: (error) => error?.ownedStopConfirmed === true,
    ...overrides,
  };
}

test('cloud benchmark exposes exactly the documented eight-job matrix', () => {
  assert.deepEqual(CIM_SCAN_CLOUD_BENCHMARK_SCENARIOS, expectedScenarios);
  assert.equal(Object.isFrozen(CIM_SCAN_CLOUD_BENCHMARK_SCENARIOS), true);
});

test('unsafe case uses only the exact harmless standard EICAR fixture', () => {
  const bytes = createEicarTestBytes();
  assert.equal(bytes.length, 68);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f');
});

test('clean, unsafe, and stale jobs require their exact result and body evidence', async () => {
  const cases = [
    ['cold-clean-1k', 1_024, 'clean', 'clean'],
    ['warm-clean-1k', 1_024, 'clean', 'clean'],
    ['cold-clean-8m', 8 * 1024 * 1024, 'clean', 'clean'],
    ['warm-clean-8m', 8 * 1024 * 1024, 'clean', 'clean'],
    ['eicar-unsafe', 68, 'unsafe', 'malware_found'],
    ['stale-signatures', 1_024, 'unavailable', 'stale_signatures'],
  ];
  for (const [scenario, sizeBytes, outcome, reasonCode] of cases) {
    const report = await runCimScanCloudBenchmarkScenario(options({
      scenario,
      async executeScan({ job, requestMaxDurationMs }) {
        assert.equal(requestMaxDurationMs, 90_000);
        assert.equal(await consume(job), sizeBytes);
        return result(outcome, reasonCode);
      },
    }));
    assert.deepEqual(report, {
      protocol: 'uckele.cim-scan-cloud-benchmark.v1',
      scenario,
      passed: true,
      outcome,
      reasonCode,
      exchanges: 1,
      bodyOpens: 1,
      bodyBytes: sizeBytes,
      externalStopConfirmationRequired: true,
    });
  }
});

test('scenario outcome mismatch fails closed instead of emitting passing evidence', async () => {
  await assert.rejects(runCimScanCloudBenchmarkScenario(options({
    scenario: 'eicar-unsafe',
    async executeScan({ job }) {
      await consume(job);
      return result('clean', 'clean');
    },
  })), /expected result/i);
});

test('replay/conflict reuses one exact request identity and opens only the first body', async () => {
  const calls = [];
  const report = await runCimScanCloudBenchmarkScenario(options({
    scenario: 'replay-conflict',
    async executeScan({ phase, job, now }) {
      calls.push({
        phase,
        requestId: job.claim.requestId,
        intakeId: job.claim.intakeId,
        sha256: job.sha256,
        now: now().toISOString(),
      });
      if (phase === 'primary') {
        assert.equal(await consume(job), 1_024);
        return result('clean', 'clean');
      }
      if (phase === 'replay') return result('clean', 'clean');
      throw new ScannerReplayConflictError();
    },
  }));

  assert.deepEqual(calls.map(({ phase }) => phase), ['primary', 'replay', 'conflict']);
  assert.equal(new Set(calls.map(({ requestId }) => requestId)).size, 1);
  assert.equal(new Set(calls.map(({ intakeId }) => intakeId)).size, 1);
  assert.equal(new Set(calls.map(({ now }) => now)).size, 1);
  assert.equal(calls[0].sha256, calls[1].sha256);
  assert.notEqual(calls[0].sha256, calls[2].sha256);
  assert.deepEqual(report, {
    protocol: 'uckele.cim-scan-cloud-benchmark.v1',
    scenario: 'replay-conflict',
    passed: true,
    outcome: 'replay_and_conflict',
    reasonCode: 'exact_identity_enforced',
    exchanges: 3,
    bodyOpens: 1,
    bodyBytes: 1_024,
    replayBodyOpens: 0,
    conflictBodyOpens: 0,
    externalStopConfirmationRequired: true,
  });
});

test('timeout job requires post-admission abort and explicit expired-orphan recovery', async () => {
  const calls = [];
  const waitedUntil = [];
  const report = await runCimScanCloudBenchmarkScenario(options({
    scenario: 'timeout-cleanup-owned-stop',
    async executeScan({ phase, job, requestMaxDurationMs }) {
      calls.push({ phase, requestMaxDurationMs });
      if (phase === 'timeout') {
        const stream = job.openByteStream();
        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        assert.equal(first.done, false);
        const timeout = new ScannerWorkerDeadlineError();
        stream.destroy(timeout);
        await assert.rejects(iterator.next(), (error) => error === timeout);
        timeout.ownedStopConfirmed = true;
        throw timeout;
      }
      if (phase === 'after-copy-crash' || phase === 'after-scan-crash') {
        assert.equal(await consume(job), 1_024);
        throw new CimScanBenchmarkAbruptExitObservedError({ ownedStopConfirmed: true });
      }
      assert.equal(await consume(job), 1_024);
      if (phase === 'cleanup-refusal') {
        return result('ambiguous', 'cleanup_uncertain', 'a'.repeat(64), 'retained');
      }
      return result('clean', 'clean');
    },
    async waitUntil(value) { waitedUntil.push(value); },
  }));

  assert.deepEqual(calls, [
    { phase: 'timeout', requestMaxDurationMs: 500 },
    { phase: 'timeout-recovery', requestMaxDurationMs: 90_000 },
    { phase: 'after-copy-crash', requestMaxDurationMs: 90_000 },
    { phase: 'after-copy-recovery', requestMaxDurationMs: 90_000 },
    { phase: 'after-scan-crash', requestMaxDurationMs: 90_000 },
    { phase: 'after-scan-recovery', requestMaxDurationMs: 90_000 },
    { phase: 'cleanup-refusal', requestMaxDurationMs: 90_000 },
    { phase: 'cleanup-refusal-recovery', requestMaxDurationMs: 90_000 },
  ]);
  assert.deepEqual(waitedUntil, Array(4).fill('2026-10-03T12:01:01.000Z'));
  assert.deepEqual(report, {
    protocol: 'uckele.cim-scan-cloud-benchmark.v1',
    scenario: 'timeout-cleanup-owned-stop',
    passed: true,
    outcome: 'fault_recovery_complete',
    reasonCode: 'deadline_crash_cleanup_and_orphan_recovery',
    exchanges: 8,
    bodyOpens: 8,
    bodyBytes: 7_169,
    timeoutBodyOpens: 1,
    afterCopyBodyOpens: 1,
    afterScanBodyOpens: 1,
    cleanupRefusalBodyOpens: 1,
    cleanupRefusalStatus: 'retained',
    recoveryBodyOpens: 4,
    recoveryOutcomes: 4,
    externalStopConfirmationRequired: true,
  });
});

test('default executor forwards separate issuance/result clocks and the exact request deadline', async () => {
  const calls = [];
  const now = () => new Date('2026-10-03T12:00:00.000Z');
  await runCimScanCloudBenchmarkScenario(options({
    scenario: 'cold-clean-1k',
    now,
    createScannerComposition(configuration) {
      calls.push(configuration);
      return {
        scanner: {
          async scan(job) {
            assert.equal(await consume(job), 1_024);
            return result('clean', 'clean');
          },
        },
      };
    },
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].benchmarkPhase, 'single');
  assert.equal(calls[0].now, now);
  assert.equal(calls[0].resultNow, now);
  assert.equal(calls[0].requestMaxDurationMs, 90_000);
});

test('default executor exposes each fault phase to preflighted external image selection and wraps only stopped crashes', async () => {
  const phases = [];
  const createScannerComposition = ({ benchmarkPhase }) => {
    phases.push(benchmarkPhase);
    return {
      scanner: {
        async scan(job) {
          if (benchmarkPhase === 'timeout') {
            const stream = job.openByteStream();
            await stream[Symbol.asyncIterator]().next();
            const error = new ScannerWorkerDeadlineError();
            error.ownedStopConfirmed = true;
            stream.destroy(error);
            throw error;
          }
          await consume(job);
          if (benchmarkPhase === 'after-copy-crash' || benchmarkPhase === 'after-scan-crash') {
            const error = new Error('expected benchmark image exited');
            error.ownedStopConfirmed = true;
            throw error;
          }
          if (benchmarkPhase === 'cleanup-refusal') {
            return result('ambiguous', 'cleanup_uncertain', 'a'.repeat(64), 'retained');
          }
          return result('clean', 'clean');
        },
      },
    };
  };
  const preflights = [];
  createScannerComposition.assertBenchmarkScenarioSupported = async (scenario) => {
    preflights.push(scenario);
  };
  const report = await runCimScanCloudBenchmarkScenario(options({
    scenario: 'timeout-cleanup-owned-stop',
    createScannerComposition,
    async waitUntil() {},
  }));
  assert.equal(report.passed, true);
  assert.deepEqual(preflights, ['timeout-cleanup-owned-stop']);
  assert.deepEqual(phases, [
    'timeout', 'timeout-recovery',
    'after-copy-crash', 'after-copy-recovery',
    'after-scan-crash', 'after-scan-recovery',
    'cleanup-refusal', 'cleanup-refusal-recovery',
  ]);
});

test('mandatory composite scenario rejects missing target preflight before executing any job', async () => {
  let compositions = 0;
  await assert.rejects(runCimScanCloudBenchmarkScenario(options({
    scenario: 'timeout-cleanup-owned-stop',
    createScannerComposition() {
      compositions += 1;
      return { scanner: { async scan() { throw new Error('must stay inert'); } } };
    },
    async waitUntil() { throw new Error('must stay inert'); },
  })), /preflight|target|topology/i);
  assert.equal(compositions, 0);
});

test('cleanup-refusal phase rejects signed cleaned status despite ambiguous outcome', async () => {
  await assert.rejects(runCimScanCloudBenchmarkScenario(options({
    scenario: 'timeout-cleanup-owned-stop',
    async executeScan({ phase, job }) {
      if (phase === 'timeout') {
        const stream = job.openByteStream();
        await stream[Symbol.asyncIterator]().next();
        const error = new ScannerWorkerDeadlineError();
        error.ownedStopConfirmed = true;
        stream.destroy(error);
        throw error;
      }
      await consume(job);
      if (phase === 'after-copy-crash' || phase === 'after-scan-crash') {
        throw new CimScanBenchmarkAbruptExitObservedError({ ownedStopConfirmed: true });
      }
      if (phase === 'cleanup-refusal') return result('ambiguous', 'cleanup_uncertain');
      return result('clean', 'clean');
    },
    async waitUntil() {},
  })), /expected result/i);
});

test('conflict proof refuses unrelated pre-body failures', async () => {
  await assert.rejects(runCimScanCloudBenchmarkScenario(options({
    scenario: 'replay-conflict',
    async executeScan({ phase, job }) {
      if (phase === 'primary') await consume(job);
      if (phase === 'conflict') throw new Error('synthetic TLS outage');
      return result('clean', 'clean');
    },
  })), /conflict.*not rejected|conflicting replay/i);
});

test('timeout proof requires its typed post-admission failure and observed stream destruction', async () => {
  for (const leaveOpen of [false, true]) {
    let stream;
    await assert.rejects(runCimScanCloudBenchmarkScenario(options({
      scenario: 'timeout-cleanup-owned-stop',
      async executeScan({ phase, job }) {
        if (phase !== 'timeout') return result('clean', 'clean');
        stream = job.openByteStream();
        const first = await stream[Symbol.asyncIterator]().next();
        assert.equal(first.done, false);
        const error = leaveOpen
          ? new ScannerWorkerDeadlineError()
          : new Error('unrelated mid-body failure');
        error.ownedStopConfirmed = true;
        if (!leaveOpen) stream.destroy(error);
        throw error;
      },
      async waitUntil() { throw new Error('must not recover after invalid timeout evidence'); },
    })), /timeout did not abort/i);
    stream?.destroy();
  }
});

test('mandatory crash phases require typed abrupt exit and exact owned-stop proof', async () => {
  for (const invalid of [
    new Error('generic disconnect'),
    new CimScanBenchmarkAbruptExitObservedError({ ownedStopConfirmed: false }),
  ]) {
    await assert.rejects(runCimScanCloudBenchmarkScenario(options({
      scenario: 'timeout-cleanup-owned-stop',
      async executeScan({ phase, job }) {
        if (phase === 'timeout') {
          const stream = job.openByteStream();
          await stream[Symbol.asyncIterator]().next();
          const error = new ScannerWorkerDeadlineError();
          error.ownedStopConfirmed = true;
          stream.destroy(error);
          throw error;
        }
        if (phase === 'after-copy-crash') {
          await consume(job);
          throw invalid;
        }
        await consume(job);
        return result('clean', 'clean');
      },
      async waitUntil() {},
    })), /abrupt|owned stop|crash/i);
  }
});

test('benchmark reports remain redacted', async () => {
  const report = await runCimScanCloudBenchmarkScenario(options({
    scenario: 'cold-clean-1k',
    async executeScan({ job }) {
      await consume(job);
      return result('clean', 'clean', 'f'.repeat(64));
    },
  }));
  const wire = JSON.stringify(report);
  for (const forbidden of [
    '00000001-1111-4111-8111-111111111111',
    'f'.repeat(64),
    'synthetic-cloud-caller',
    'token',
    'private',
  ]) assert.equal(wire.includes(forbidden), false, forbidden);
});
