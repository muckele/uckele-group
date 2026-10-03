import test from 'node:test';
import assert from 'node:assert/strict';
import { runSyntheticCimScannerHarness } from '../scripts/run-cim-scan-synthetic-harness.js';

test('offline scanner harness runs exactly seven synthetic protocol cases', async () => {
  const report = await runSyntheticCimScannerHarness();
  assert.equal(report.protocolOnly, true);
  assert.equal(report.realEicarDetectionClaimed, false);
  assert.deepEqual(report.cases.map(({ name }) => name), [
    'clean-1-kib',
    'clean-8-mib',
    'fake-eicar-verdict',
    'stale-signatures',
    'hash-and-size-mismatch',
    'replay-duplicate-and-conflict-without-body-reopen',
    'timeout-task-copy-cleanup-and-owned-stop',
  ]);
  assert.equal(report.cases.every(({ passed }) => passed === true), true);
  const fakeEicar = report.cases.find(({ name }) => name === 'fake-eicar-verdict');
  assert.equal(fakeEicar.outcome, 'unsafe');
  assert.equal(fakeEicar.scanner, 'synthetic-verdict-only');
  const replay = report.cases.find(({ name }) => name.startsWith('replay-duplicate'));
  assert.equal(replay.bodyOpenCount, 1);
  assert.equal(replay.conflictOpenedBody, false);
});
