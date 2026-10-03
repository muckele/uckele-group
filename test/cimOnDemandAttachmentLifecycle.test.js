import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  publishApprovedCimAttachment,
  scanCimAttachmentOnDemand,
} from '../server/services/cimAttachmentIntake.js';

const bytes = Buffer.from('%PDF-1.7 on-demand lifecycle fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const now = new Date('2026-10-03T12:00:00.000Z');

function lifecycleStorage() {
  let row = {
    id: '82222222-2222-4222-8222-222222222222',
    lifecycle_status: 'scan-pending', scan_status: 'pending', scan_attempt_count: 0,
    quarantine_path: `${sha256}.pdf`, sha256, size_bytes: bytes.length,
    detected_mime_type: 'application/pdf',
  };
  return {
    get row() { return structuredClone(row); },
    reads: 0,
    claims: 0,
    completions: 0,
    async getCimAttachmentIntake() { this.reads += 1; return structuredClone(row); },
    async claimCimAttachmentScan(command) {
      this.claims += 1;
      if (row.lifecycle_status !== 'scan-pending') return null;
      row = {
        ...row, lifecycle_status: 'scanning', scan_attempt_count: 1,
        scan_request_id: command.requestId, scan_job_owner: command.jobOwner,
        scan_requested_at: command.claimedAt,
        scan_lease_expires_at: command.leaseExpiresAt,
      };
      return structuredClone(row);
    },
    async completeCimAttachmentScan(command) {
      this.completions += 1;
      if (row.lifecycle_status !== 'scanning' || row.scan_request_id !== command.requestId
        || row.scan_job_owner !== command.jobOwner || row.scan_attempt_count !== command.attempt) return null;
      row = {
        ...row,
        lifecycle_status: command.result.outcome === 'clean' ? 'awaiting-owner-approval' : 'scan-unavailable',
        scan_status: command.result.outcome === 'clean' ? 'clean' : 'unavailable',
        scan_completed_at: command.completedAt,
        scan_verdict_expires_at: command.result.outcome === 'clean' ? command.verdictExpiresAt : null,
        scan_signature_version: command.result.signatureVersion || null,
        hold_reason: command.result.outcome === 'ambiguous' ? 'scan_ambiguous' : null,
      };
      return structuredClone(row);
    },
  };
}

test('on-demand lifecycle rejects before storage and bytes unless scanner gate is explicit', async () => {
  let storageTouched = false;
  let scannerTouched = false;
  await assert.rejects(scanCimAttachmentOnDemand({
    intakeId: '82222222-2222-4222-8222-222222222222',
    jobOwner: 'synthetic-owner',
    readiness: { scannerReady: false },
    storage: new Proxy({}, { get() { storageTouched = true; return undefined; } }),
    scanner: new Proxy({}, { get() { scannerTouched = true; return undefined; } }),
  }), /scanner is not ready/i);
  assert.equal(storageTouched, false);
  assert.equal(scannerTouched, false);
});

test('on-demand lifecycle claims before file access and completes exact dynamic evidence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-on-demand-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, `${sha256}.pdf`), bytes, { mode: 0o600 });
  const storage = lifecycleStorage();
  let scannedBytes = null;
  const scanner = {
    async scan({ claim, openByteStream, sha256: expectedHash, sizeBytes, mimeType }) {
      assert.equal(storage.claims, 1);
      assert.equal(claim.requestId, storage.row.scan_request_id);
      assert.equal(expectedHash, sha256);
      assert.equal(sizeBytes, bytes.length);
      assert.equal(mimeType, 'application/pdf');
      const parts = [];
      for await (const chunk of openByteStream()) parts.push(chunk);
      scannedBytes = Buffer.concat(parts);
      return {
        outcome: 'clean', reasonCode: 'clean', engineVersion: 'ClamAV synthetic',
        signatureVersion: 'db-1', signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
        scannedAt: '2026-10-03T12:00:10.000Z',
        protocolResultExpiresAt: '2026-10-03T12:02:00.000Z',
        requestDigest: 'e'.repeat(64),
      };
    },
  };
  const result = await scanCimAttachmentOnDemand({
    intakeId: storage.row.id,
    jobOwner: 'synthetic-owner',
    storage,
    quarantineRoot: root,
    scanner,
    readiness: { scannerReady: true },
    now: () => new Date(now),
  });
  assert.deepEqual(scannedBytes, bytes);
  assert.equal(result.lifecycle_status, 'awaiting-owner-approval');
  assert.equal(result.scan_signature_version, 'db-1');
  assert.equal(result.scan_verdict_expires_at, '2026-10-04T12:00:00.000Z');
  assert.equal(storage.completions, 1);
});

test('on-demand lifecycle cannot promote an unbound injected clean outcome', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-on-demand-unbound-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, `${sha256}.pdf`), bytes, { mode: 0o600 });
  const storage = lifecycleStorage();
  const result = await scanCimAttachmentOnDemand({
    intakeId: storage.row.id,
    jobOwner: 'synthetic-owner',
    storage,
    quarantineRoot: root,
    scanner: { async scan() { return { outcome: 'clean', reasonCode: 'clean' }; } },
    readiness: { scannerReady: true },
    now: () => new Date(now),
  });
  assert.equal(result.lifecycle_status, 'scan-unavailable');
  assert.equal(result.scan_status, 'unavailable');
  assert.equal(result.scan_verdict_expires_at, null);
});

test('concurrent loser never opens quarantine bytes or invokes scanner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-on-demand-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = lifecycleStorage();
  storage.claimCimAttachmentScan = async () => null;
  let invoked = 0;
  await assert.rejects(scanCimAttachmentOnDemand({
    intakeId: storage.row.id, jobOwner: 'synthetic-owner', storage, quarantineRoot: root,
    scanner: { async scan() { invoked += 1; } }, readiness: { scannerReady: true },
    now: () => new Date(now),
  }), /claim|owned|eligible/i);
  assert.equal(invoked, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('on-demand completion fences the lease with trusted receipt time, not worker scan time', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-on-demand-late-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, `${sha256}.pdf`), bytes, { mode: 0o600 });
  const storage = lifecycleStorage();
  let completion;
  storage.completeCimAttachmentScan = async (command) => {
    completion = command;
    return command.completedAt < storage.row.scan_lease_expires_at ? storage.row : null;
  };
  let clockReads = 0;
  await assert.rejects(scanCimAttachmentOnDemand({
    intakeId: storage.row.id,
    jobOwner: 'synthetic-owner',
    storage,
    quarantineRoot: root,
    scanner: {
      async scan() {
        return {
          outcome: 'clean', reasonCode: 'clean', engineVersion: 'ClamAV synthetic',
          signatureVersion: 'db-1', signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
          scannedAt: '2026-10-03T12:00:10.000Z',
          protocolResultExpiresAt: '2026-10-03T12:02:00.000Z', requestDigest: 'e'.repeat(64),
        };
      },
    },
    readiness: { scannerReady: true },
    now: () => new Date(clockReads++ === 0
      ? '2026-10-03T12:00:00.000Z' : '2026-10-03T12:05:00.000Z'),
  }), /lost its lifecycle lease/i);
  assert.equal(completion.completedAt, '2026-10-03T12:05:00.000Z');
});

test('owner publication fails closed before vault access when clean verdict expired', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-expired-verdict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let publicationClaimed = 0;
  let published = 0;
  const storage = {
    async getCimAttachmentIntake() {
      return {
        id: '82222222-2222-4222-8222-222222222222', communication_id: 'comm-1',
        lifecycle_status: 'awaiting-owner-approval', scan_status: 'clean',
        scan_verdict_expires_at: '2026-10-03T11:59:59.000Z',
        original_file_name: 'fixture.pdf', detected_mime_type: 'application/pdf',
        size_bytes: bytes.length, sha256, quarantine_path: `${sha256}.pdf`,
      };
    },
    async getCrmCommunication() {
      return { id: 'comm-1', direction: 'inbound', submission_id: 'submission-1' };
    },
    async getSubmission() { return { id: 'submission-1', email: 'broker@example.test', name: 'Broker' }; },
    async claimCimAttachmentPublication() { publicationClaimed += 1; return null; },
    async publishCimAttachmentToVault() { published += 1; },
  };
  await assert.rejects(publishApprovedCimAttachment({
    intakeId: '82222222-2222-4222-8222-222222222222', submissionId: 'submission-1',
    documentType: 'cim', actor: 'owner@example.test', storage,
    quarantineRoot: path.join(root, 'quarantine'), vaultRoot: path.join(root, 'vault'),
    now,
  }), /verdict expired/i);
  assert.equal(publicationClaimed, 0);
  assert.equal(published, 0);
  assert.equal(await fs.stat(root).then(() => true), true);
  assert.deepEqual(await fs.readdir(root), []);
});
