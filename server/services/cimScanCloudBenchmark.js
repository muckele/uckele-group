import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { CIM_SCAN_PROTOCOL_LIMITS } from './cimScanProtocol.js';
import { isScannerReplayConflictError } from './flyMachineOperabilityAdapters.js';
import { isScannerWorkerDeadlineError } from './nodePinnedHttpsExchange.js';
import {
  createGeneratedSyntheticScanJob,
  createExactSyntheticScanJob,
} from './cimScanSyntheticCloudCaller.js';

const reportProtocol = 'uckele.cim-scan-cloud-benchmark.v1';
const standardDurationMs = CIM_SCAN_PROTOCOL_LIMITS.maxWorkerDurationMs;
const timeoutDurationMs = 500;
const timeoutLeaseMs = 60_000;
const timeoutProbeDelayMs = 750;
const timeoutRemainderDelayMs = 2_000;
const orphanExpiryGraceMs = 1_000;

export const CIM_SCAN_CLOUD_BENCHMARK_SCENARIOS = Object.freeze([
  'cold-clean-1k',
  'warm-clean-1k',
  'cold-clean-8m',
  'warm-clean-8m',
  'eicar-unsafe',
  'stale-signatures',
  'replay-conflict',
  'timeout-cleanup-owned-stop',
]);

const simpleScenarios = Object.freeze({
  'cold-clean-1k': Object.freeze({ sizeBytes: 1_024, outcome: 'clean', reasonCode: 'clean' }),
  'warm-clean-1k': Object.freeze({ sizeBytes: 1_024, outcome: 'clean', reasonCode: 'clean' }),
  'cold-clean-8m': Object.freeze({
    sizeBytes: CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes,
    outcome: 'clean', reasonCode: 'clean',
  }),
  'warm-clean-8m': Object.freeze({
    sizeBytes: CIM_SCAN_PROTOCOL_LIMITS.maxAttachmentBytes,
    outcome: 'clean', reasonCode: 'clean',
  }),
  'eicar-unsafe': Object.freeze({ outcome: 'unsafe', reasonCode: 'malware_found' }),
  'stale-signatures': Object.freeze({
    sizeBytes: 1_024, outcome: 'unavailable', reasonCode: 'stale_signatures',
  }),
});

function exactDate(value, label = 'Benchmark clock') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid.`);
  return date;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new Error(`${label} is required.`);
  return value;
}

function scanInput(job) {
  return {
    claim: job.claim,
    sha256: job.sha256,
    sizeBytes: job.sizeBytes,
    mimeType: job.mimeType,
    openByteStream: job.openByteStream,
  };
}

function requireExpectedResult(result, expected) {
  if (!result || result.outcome !== expected.outcome || result.reasonCode !== expected.reasonCode) {
    throw new Error('Cloud benchmark scenario did not return its expected result.');
  }
  return result;
}

function requireExactBody(job, expectedOpens = 1) {
  if (job.openCount() !== expectedOpens) {
    throw new Error('Cloud benchmark body-open evidence did not match.');
  }
  if (expectedOpens === 1 && job.bodyByteCount() !== job.sizeBytes) {
    throw new Error('Cloud benchmark body-byte evidence did not match.');
  }
}

function report(scenario, fields) {
  return Object.freeze({
    protocol: reportProtocol,
    scenario,
    passed: true,
    ...fields,
    externalStopConfirmationRequired: true,
  });
}

function resultIdentity(result) {
  return JSON.stringify({
    outcome: result?.outcome,
    reasonCode: result?.reasonCode,
    engineVersion: result?.engineVersion,
    signatureVersion: result?.signatureVersion,
    signatureUpdatedAt: result?.signatureUpdatedAt,
    scannedAt: result?.scannedAt,
    protocolResultExpiresAt: result?.protocolResultExpiresAt,
    requestDigest: result?.requestDigest,
  });
}

function defaultWaitUntil(value) {
  const target = Date.parse(value);
  const delayMs = target - Date.now();
  if (!Number.isFinite(target) || delayMs < 0 || delayMs > timeoutLeaseMs + orphanExpiryGraceMs) {
    throw new Error('Benchmark orphan-recovery wait is invalid.');
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createExecutor({ executeScan, createScannerComposition }) {
  if (executeScan !== undefined) return requireFunction(executeScan, 'Benchmark scan executor');
  requireFunction(createScannerComposition, 'Benchmark scanner composition factory');
  return async ({ job, now, resultNow = now, requestMaxDurationMs }) => {
    const composition = createScannerComposition({ now, resultNow, requestMaxDurationMs });
    if (!composition?.scanner || typeof composition.scanner.scan !== 'function') {
      throw new Error('Benchmark scanner composition is invalid.');
    }
    return composition.scanner.scan(scanInput(job));
  };
}

export function createEicarTestBytes() {
  return Buffer.from([
    'X5O!P%@AP[4', '\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-',
    'ANTIVIRUS-TEST-FILE!', '$H+H*',
  ].join(''), 'ascii');
}

function generatedJob({ name, sizeBytes, requestId, intakeId, jobOwner, now, leaseDurationMs }) {
  return createGeneratedSyntheticScanJob({
    name, sizeBytes, requestId, intakeId, jobOwner, now,
    ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
  });
}

function exactJob({ name, bytes, requestId, intakeId, jobOwner, now, leaseDurationMs }) {
  return createExactSyntheticScanJob({
    name, bytes, requestId, intakeId, jobOwner, now,
    ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
  });
}

function stalledJob(options) {
  const base = generatedJob(options);
  const fillByte = createHash('sha256').update(options.name, 'utf8').digest()[0];
  let opens = 0;
  let emitted = 0;
  let closed = false;
  return Object.freeze({
    ...base,
    openCount: () => opens,
    bodyByteCount: () => emitted,
    streamClosed: () => closed,
    openByteStream() {
      if (opens !== 0) throw new Error('Synthetic scan bytes may be opened only once.');
      opens += 1;
      let phase = 0;
      let delay;
      return new Readable({
        read() {
          if (phase === 0) {
            phase = 1;
            emitted += 1;
            this.push(Buffer.from([fillByte]));
            return;
          }
          if (phase === 1) {
            phase = 2;
            delay = setTimeout(() => {
              delay = undefined;
              if (this.destroyed) return;
              phase = 3;
              emitted += 1;
              this.push(Buffer.from([fillByte]));
            }, timeoutProbeDelayMs);
            return;
          }
          if (phase === 3) {
            phase = 4;
            delay = setTimeout(() => {
              delay = undefined;
              if (this.destroyed) return;
              const remaining = base.sizeBytes - 2;
              emitted += remaining;
              this.push(Buffer.alloc(remaining, fillByte));
              this.push(null);
            }, timeoutRemainderDelayMs);
          }
        },
        destroy(error, callback) {
          closed = true;
          if (delay) clearTimeout(delay);
          delay = undefined;
          callback(error);
        },
      });
    },
  });
}

async function runSimple({ scenario, definition, execute, jobOwner, now, createUuid }) {
  const job = scenario === 'eicar-unsafe'
    ? exactJob({
      name: scenario, bytes: createEicarTestBytes(), requestId: createUuid(),
      intakeId: createUuid(), jobOwner, now,
    })
    : generatedJob({
      name: scenario, sizeBytes: definition.sizeBytes, requestId: createUuid(),
      intakeId: createUuid(), jobOwner, now,
    });
  const result = requireExpectedResult(await execute({
    phase: 'single', job, now, resultNow: now, requestMaxDurationMs: standardDurationMs,
  }), definition);
  requireExactBody(job);
  return report(scenario, {
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    exchanges: 1,
    bodyOpens: job.openCount(),
    bodyBytes: job.bodyByteCount(),
  });
}

async function runReplayConflict({ scenario, execute, jobOwner, now, createUuid }) {
  const fixedDate = exactDate(now());
  const fixedNow = () => new Date(fixedDate);
  const requestId = createUuid();
  const intakeId = createUuid();
  const identity = { requestId, intakeId, jobOwner, now: fixedNow };
  const primary = generatedJob({ name: 'replay-exact', sizeBytes: 1_024, ...identity });
  const replay = generatedJob({ name: 'replay-exact', sizeBytes: 1_024, ...identity });
  const conflict = generatedJob({ name: 'replay-conflict', sizeBytes: 1_024, ...identity });
  const firstResult = requireExpectedResult(await execute({
    phase: 'primary', job: primary, now: fixedNow, resultNow: now,
    requestMaxDurationMs: standardDurationMs,
  }), { outcome: 'clean', reasonCode: 'clean' });
  const replayResult = requireExpectedResult(await execute({
    phase: 'replay', job: replay, now: fixedNow, resultNow: now,
    requestMaxDurationMs: standardDurationMs,
  }), { outcome: 'clean', reasonCode: 'clean' });
  requireExactBody(primary);
  requireExactBody(replay, 0);
  if (resultIdentity(firstResult) !== resultIdentity(replayResult)) {
    throw new Error('Cloud benchmark replay result identity changed.');
  }
  let conflictRejected = false;
  try {
    await execute({
      phase: 'conflict', job: conflict, now: fixedNow,
      resultNow: now,
      requestMaxDurationMs: standardDurationMs,
    });
  } catch (error) { conflictRejected = isScannerReplayConflictError(error); }
  if (!conflictRejected || conflict.openCount() !== 0) {
    throw new Error('Cloud benchmark conflicting replay was not rejected before body open.');
  }
  return report(scenario, {
    outcome: 'replay_and_conflict',
    reasonCode: 'exact_identity_enforced',
    exchanges: 3,
    bodyOpens: primary.openCount(),
    bodyBytes: primary.bodyByteCount(),
    replayBodyOpens: replay.openCount(),
    conflictBodyOpens: conflict.openCount(),
  });
}

async function runTimeout({ scenario, execute, jobOwner, now, createUuid, waitUntil }) {
  const issuedAt = exactDate(now());
  const timeoutNow = () => new Date(issuedAt);
  const timed = stalledJob({
    name: 'timeout-stream', sizeBytes: 1_024, requestId: createUuid(), intakeId: createUuid(),
    jobOwner, now: timeoutNow, leaseDurationMs: timeoutLeaseMs,
  });
  let timedOut = false;
  try {
    await execute({
      phase: 'timeout', job: timed, now: timeoutNow,
      resultNow: now,
      requestMaxDurationMs: timeoutDurationMs,
    });
  } catch (error) { timedOut = isScannerWorkerDeadlineError(error); }
  if (!timedOut || timed.openCount() !== 1
    || timed.bodyByteCount() < 1 || timed.bodyByteCount() >= timed.sizeBytes
    || timed.streamClosed() !== true) {
    throw new Error('Cloud benchmark timeout did not abort an admitted partial body.');
  }
  const cleanupAt = new Date(Date.parse(timed.claim.leaseExpiresAt) + orphanExpiryGraceMs).toISOString();
  await waitUntil(cleanupAt);
  const recovery = generatedJob({
    name: 'timeout-recovery', sizeBytes: 1_024, requestId: createUuid(), intakeId: createUuid(),
    jobOwner, now,
  });
  const recoveryResult = requireExpectedResult(await execute({
    phase: 'recovery', job: recovery, now, resultNow: now,
    requestMaxDurationMs: standardDurationMs,
  }), { outcome: 'clean', reasonCode: 'clean' });
  requireExactBody(recovery);
  return report(scenario, {
    outcome: 'expected_timeout',
    reasonCode: 'deadline_and_orphan_recovery',
    exchanges: 2,
    bodyOpens: timed.openCount() + recovery.openCount(),
    bodyBytes: timed.bodyByteCount() + recovery.bodyByteCount(),
    timeoutBodyOpens: timed.openCount(),
    recoveryBodyOpens: recovery.openCount(),
    recoveryOutcome: recoveryResult.outcome,
  });
}

export async function runCimScanCloudBenchmarkScenario({
  scenario,
  jobOwner,
  createScannerComposition,
  executeScan,
  now = () => new Date(),
  createUuid = randomUUID,
  waitUntil = defaultWaitUntil,
} = {}) {
  if (!CIM_SCAN_CLOUD_BENCHMARK_SCENARIOS.includes(scenario)) {
    throw new Error('One exact cloud benchmark scenario is required.');
  }
  if (typeof jobOwner !== 'string' || !jobOwner) throw new Error('Benchmark job owner is required.');
  requireFunction(now, 'Benchmark clock');
  requireFunction(createUuid, 'Benchmark UUID factory');
  requireFunction(waitUntil, 'Benchmark orphan-recovery wait');
  const execute = createExecutor({ executeScan, createScannerComposition });
  const common = { scenario, execute, jobOwner, now, createUuid };
  if (scenario === 'replay-conflict') return runReplayConflict(common);
  if (scenario === 'timeout-cleanup-owned-stop') return runTimeout({ ...common, waitUntil });
  return runSimple({ ...common, definition: simpleScenarios[scenario] });
}
