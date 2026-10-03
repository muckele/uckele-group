import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanCimAttachmentOnDemand } from '../server/services/cimAttachmentIntake.js';
import { createClamavUnixSocketScanner } from '../server/services/clamavUnixSocketScanner.js';
import { createFlyMachineScanTransport } from '../server/services/flyMachineScanTransport.js';
import { createOnDemandScannerAdapter } from '../server/services/onDemandCimScanner.js';
import { runOnDemandScanTask } from '../server/services/cimScanWorker.js';
import { createSyntheticAdmission, createSyntheticReplayStore } from './support/cimScanFixtures.js';

test('synthetic lifecycle traverses claim, Machine fencing, worker, Unix ClamAV, and clean hold', async (t) => {
  const quarantineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-e2e-quarantine-'));
  const workerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-e2e-worker-'));
  t.after(() => Promise.all([
    fs.rm(quarantineRoot, { recursive: true, force: true }),
    fs.rm(workerRoot, { recursive: true, force: true }),
  ]));
  const content = Buffer.from('%PDF-1.7 synthetic bounded end-to-end fixture');
  const sha256 = createHash('sha256').update(content).digest('hex');
  await fs.writeFile(path.join(quarantineRoot, `${sha256}.pdf`), content, { mode: 0o600 });
  const clock = new Date();
  const signatureUpdatedAt = new Date(clock.getTime() - 5 * 60_000).toISOString();
  const key = Buffer.from('synthetic-p8-03-end-to-end-key-only');
  const keyResolver = (keyId) => keyId === 'test-key-1' ? key : null;
  let row = {
    id: '92222222-2222-4222-8222-222222222222', lifecycle_status: 'scan-pending',
    scan_status: 'pending', scan_attempt_count: 0, quarantine_path: `${sha256}.pdf`,
    sha256, size_bytes: content.length, detected_mime_type: 'application/pdf',
  };
  const storage = {
    async claimCimAttachmentScan(command) {
      if (row.lifecycle_status !== 'scan-pending') return null;
      row = { ...row, lifecycle_status: 'scanning', scan_attempt_count: 1,
        scan_request_id: command.requestId, scan_job_owner: command.jobOwner,
        scan_requested_at: command.claimedAt,
        scan_lease_expires_at: command.leaseExpiresAt };
      return structuredClone(row);
    },
    async completeCimAttachmentScan(command) {
      if (command.requestId !== row.scan_request_id || command.jobOwner !== row.scan_job_owner) return null;
      row = { ...row, lifecycle_status: command.result.outcome === 'clean'
        ? 'awaiting-owner-approval' : 'scan-unavailable', scan_status: command.result.outcome,
      scan_signature_version: command.result.signatureVersion,
      scan_verdict_expires_at: command.verdictExpiresAt };
      return structuredClone(row);
    },
  };

  const responses = [
    `ClamAV 1.synthetic/27831/${signatureUpdatedAt}\0`,
    'stream: OK\0',
    `ClamAV 1.synthetic/27831/${signatureUpdatedAt}\0`,
  ];
  let connection = 0;
  const clamav = createClamavUnixSocketScanner({
    socketPath: '/run/clamav/clamd.sock',
    async connectUnix() {
      const response = responses[connection++];
      return {
        peerIdentity: 'unix-socket-inode:synthetic-e2e',
        async write() {},
        async *read() { yield Buffer.from(response); },
        destroy() {},
      };
    },
  });
  let generationOwner = null;
  const machineController = {
    async acquireStoppedSession({ sessionGeneration }) {
      generationOwner = sessionGeneration;
      return { providerGeneration: 'provider-generation-1', initialState: 'stopped' };
    },
    async startSession() {},
    async ownsSession({ sessionGeneration }) { return generationOwner === sessionGeneration; },
    async stopSessionIfOwned({ sessionGeneration }) {
      if (generationOwner !== sessionGeneration) return false;
      generationOwner = null;
      return true;
    },
  };
  const replayStore = createSyntheticReplayStore({ now: () => new Date(clock) });
  const admission = createSyntheticAdmission();
  const requestClient = {
    async authorize({ requestWire }) {
      return {
        async sendBody({ openByteStream }) {
          return runOnDemandScanTask({
            requestWire, openByteStream, keyResolver, replayStore, admission,
            ephemeralRoot: workerRoot, scanner: clamav, now: () => new Date(clock),
          });
        },
        abort() {},
      };
    },
  };
  const transport = createFlyMachineScanTransport({
    machineId: 'synthetic-machine-1', machineController, requestClient,
  });
  const scanner = createOnDemandScannerAdapter({
    keyId: 'test-key-1', keyResolver, transport, now: () => new Date(clock),
  });
  const result = await scanCimAttachmentOnDemand({
    intakeId: row.id, jobOwner: 'synthetic-app-1', storage, quarantineRoot,
    scanner, readiness: { scannerReady: true }, now: () => new Date(clock),
  });
  assert.equal(result.lifecycle_status, 'awaiting-owner-approval');
  assert.equal(result.scan_status, 'clean');
  assert.equal(result.scan_signature_version, '27831');
  assert.equal(generationOwner, null);
  assert.deepEqual(await fs.readdir(workerRoot), []);
  assert.deepEqual(await fs.readFile(path.join(quarantineRoot, `${sha256}.pdf`)), content);
});
