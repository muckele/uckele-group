import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { createCimScanStaleBenchmarkClock } from '../server/services/cimScanWorkerBenchmarkClock.js';

test('stale benchmark clock advances only the injected application clock by exactly 25 hours', () => {
  const realNow = new Date('2026-10-03T12:00:00.000Z');
  const now = createCimScanStaleBenchmarkClock({ wallNow: () => realNow });
  const observed = now();
  assert.deepEqual(observed, new Date('2026-10-04T13:00:00.000Z'));
  assert.notEqual(observed, realNow);
  assert.throws(() => createCimScanStaleBenchmarkClock(), /clock|required/i);
});

test('normal worker entrypoint cannot activate the separate stale benchmark clock', async () => {
  const [normalScript, staleScript, callerScript, httpEntrypoint, staleEntrypoint] = await Promise.all([
    fsp.readFile('scripts/run-cim-scan-worker-http.js', 'utf8'),
    fsp.readFile('scripts/run-cim-scan-worker-stale-benchmark.js', 'utf8'),
    fsp.readFile('scripts/run-cim-scan-cloud-synthetic.js', 'utf8'),
    fsp.readFile('containers/cim-scan-worker/http-entrypoint.sh', 'utf8'),
    fsp.readFile('containers/cim-scan-worker/stale-benchmark-entrypoint.sh', 'utf8'),
  ]);
  assert.match(normalScript, /createCimScanWorkerHttpRuntime/);
  assert.doesNotMatch(normalScript, /BenchmarkClock|CLOCK_OFFSET|stale/i);
  assert.match(staleScript, /createCimScanStaleBenchmarkClock/);
  assert.match(staleScript, /signatureNow/);
  assert.match(staleScript, /now:\s*realNow/);
  assert.doesNotMatch(staleScript, /process\.env|CLOCK_OFFSET/);
  assert.doesNotMatch(callerScript, /BenchmarkClock|createSyntheticScenarioClock|CLOCK_OFFSET/);
  assert.match(httpEntrypoint, /run-cim-scan-worker-http\.js/);
  assert.doesNotMatch(httpEntrypoint, /stale|CLOCK_OFFSET/i);
  assert.match(staleEntrypoint, /run-cim-scan-worker-stale-benchmark\.js/);
  assert.match(staleEntrypoint, /clamd/);
  assert.match(staleEntrypoint, /check-cim-scan-worker-health\.js/);
  assert.doesNotMatch(staleEntrypoint, /process\.env|CLOCK_OFFSET/);
});
