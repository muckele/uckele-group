import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, test } from 'node:test';
import { evaluateAcquisitionMaterialsState } from '../server/services/acquisitionMaterials.js';
import { createBackupBundle, restoreBackupBundle, verifyBackupBundle } from '../server/services/backups.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import {
  captureCimAttachment as captureCimAttachmentWithGate,
  cleanupStaleCimAttachmentPartials,
  publishApprovedCimAttachment,
  scanCimAttachment as scanCimAttachmentWithGate,
} from '../server/services/cimAttachmentIntake.js';
import { createDeterministicFakeScanner } from './support/cimAttachmentScanner.js';

const readyIntake = Object.freeze({ enabled: true, scannerReady: true });

function captureCimAttachment(options) {
  return captureCimAttachmentWithGate({ readiness: readyIntake, ...options });
}

function scanCimAttachment(options) {
  return scanCimAttachmentWithGate({ readiness: readyIntake, ...options });
}

async function seedSyntheticPublicationVerdict(storage, intakeId) {
  const updated = await storage.updateCimAttachmentIntake(intakeId, {
    scan_completed_at: '2026-10-03T12:00:00.000Z',
    scan_request_digest: 'f'.repeat(64),
    scan_signature_version: 'synthetic-db-1',
    scan_signature_updated_at: '2026-10-03T11:55:00.000Z',
    scan_verdict_expires_at: '2099-10-04T12:00:00.000Z',
  }, { expectedStatus: 'awaiting-owner-approval' });
  assert.ok(updated, 'test fixture must seed explicit synthetic publication authority');
}

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function pdfBytes(suffix = '') {
  return Buffer.from(`%PDF-1.7\nsecure fixture ${suffix}\n%%EOF\n`);
}

function streamBytes(bytes, chunkSize = bytes.length) {
  return Readable.from((function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      yield bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    }
  }()));
}

function metadata(overrides = {}) {
  return {
    communicationId: 'comm-1',
    provider: 'resend',
    providerMessageId: 'message-1',
    providerAttachmentId: 'attachment-1',
    fileName: 'Deal CIM.pdf',
    declaredMimeType: 'application/pdf',
    ...overrides,
  };
}

function memoryStorage({ communicationSubmissionId = 'submission-1' } = {}) {
  const rows = new Map();
  const providerKeys = new Map();
  const documents = new Map();
  const requests = new Map();
  let communication = {
    id: 'comm-1',
    direction: 'inbound',
    submission_id: communicationSubmissionId,
    provider: 'resend',
    provider_message_id: 'message-1',
  };
  return {
    provider: 'memory',
    rows,
    documents,
    requests,
    setCommunication(value) { communication = value; },
    async getCimAttachmentIntakeByProviderAttachment(provider, messageId, attachmentId) {
      return rows.get(providerKeys.get(`${provider}:${messageId}:${attachmentId}`)) || null;
    },
    async getCimAttachmentIntake(id) { return rows.get(id) || null; },
    async getCimAttachmentIntakeBySha256(sha256) {
      return [...rows.values()].find((row) => row.sha256 === sha256 && row.quarantine_path) || null;
    },
    async listCimAttachmentIntakes() { return [...rows.values()].map((row) => structuredClone(row)); },
    async insertCimAttachmentIntake(row) {
      const key = `${row.provider}:${row.provider_message_id}:${row.provider_attachment_id}`;
      const existing = providerKeys.get(key);
      if (existing) return rows.get(existing);
      providerKeys.set(key, row.id);
      rows.set(row.id, structuredClone(row));
      return structuredClone(row);
    },
    async updateCimAttachmentIntake(id, values, options = {}) {
      const current = rows.get(id);
      if (!current || (options.expectedStatus && current.lifecycle_status !== options.expectedStatus)) return null;
      const next = { ...current, ...structuredClone(values) };
      rows.set(id, next);
      return structuredClone(next);
    },
    async claimCimAttachmentPublication(command) {
      const current = rows.get(command.intakeId);
      if (!current || current.lifecycle_status !== 'awaiting-owner-approval'
        || current.scan_status !== 'clean' || !current.scan_verdict_expires_at
        || current.scan_verdict_expires_at <= command.approvedAt) return null;
      const next = {
        ...current,
        lifecycle_status: 'publishing',
        owner_approved_at: command.approvedAt,
        owner_approved_by: command.ownerApprovedBy,
        approved_submission_id: command.approvedSubmissionId,
        approved_document_type: command.approvedDocumentType,
        vault_request_id: command.vaultRequestId,
        vault_document_id: command.vaultDocumentId,
        vault_relative_path: command.vaultRelativePath,
        hold_reason: null,
        updated_at: command.approvedAt,
      };
      rows.set(command.intakeId, next);
      return structuredClone(next);
    },
    async getCrmCommunication(id) { return communication?.id === id ? structuredClone(communication) : null; },
    async getSubmission(id) { return id === 'submission-1' || id === 'submission-2' ? { id, email: 'broker@example.test', name: 'Broker' } : null; },
    async publishCimAttachmentToVault({ intakeId, expectedStatus, request, document, publishedAt }) {
      const current = rows.get(intakeId);
      if (!current || current.lifecycle_status !== expectedStatus) return null;
      requests.set(request.id, structuredClone(request));
      documents.set(document.id, structuredClone(document));
      const next = {
        ...current,
        lifecycle_status: 'published',
        vault_request_id: request.id,
        vault_document_id: document.id,
        published_at: publishedAt,
        updated_at: publishedAt,
      };
      rows.set(intakeId, next);
      return structuredClone(next);
    },
  };
}

async function testRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ug-cim-attachment-'));
  roots.push(root);
  return root;
}

function submission(id = 'submission-1') {
  const timestamp = '2026-10-03T12:00:00.000Z';
  return {
    id, created_at: timestamp, updated_at: timestamp, status: 'review', spam_score: 0,
    spam_reasons: [], delivery_provider: 'manual', delivery_status: 'not-applicable',
    delivery_error: '', crm_status: 'not-applicable', crm_error: '', source: 'attachment-test',
    ip_hash: '', user_agent: '', name: 'Broker', email: 'broker@example.test', phone: '',
    company: 'Target', role: 'Broker', message: 'Attached.', status_updated_at: timestamp,
    listing_url: '', business_website: '', prospectus_url: '', asking_price: '', ttm_revenue: '',
    ttm_ebitda: '', ebitda_multiple: '', net_margin: '', business_age: '', sba_eligible: 'unknown',
    broker_name: 'Broker', broker_email: 'broker@example.test', broker_phone: '', seller_name: '',
    seller_email: '', seller_phone: '', lead_type: 'broker', priority: 'normal', tags: [],
    assigned_to: '', notes: '', follow_up_state: 'needs-response', next_action_at: null,
    last_contacted_at: null, metadata: {},
  };
}

function communication(submissionId = 'submission-1') {
  const timestamp = '2026-10-03T12:00:00.000Z';
  return {
    id: 'comm-1', submission_id: submissionId, opportunity_id: null, deal_key: null,
    cim_request_id: null, direction: 'inbound', channel: 'email', source: 'resend-webhook',
    kind: 'broker-reply', provider: 'resend', provider_message_id: 'message-1',
    source_event_id: 'event-1', idempotency_key: 'attachment-test-communication', message_id: null,
    in_reply_to: null, references_json: [], parent_communication_id: null, thread_key: null,
    legacy_content_unavailable: false, content_redaction_state: 'none', recommendation_id: null,
    outbox_id: null, headers_json: {}, reply_to_address: '', from_address: 'broker@example.test',
    to_addresses: ['owner@example.test'], cc_addresses: [], bcc_addresses: [], subject: 'CIM attached',
    body_text: 'Attached.', body_html_sanitized: '', occurred_at: timestamp, created_at: timestamp,
    updated_at: timestamp, delivery_state: 'received', delivery_state_at: timestamp,
    content_state: 'available', content_attempt_count: 1, content_last_error: null,
    content_next_attempt_at: null, attachment_metadata: [], assigned_at: timestamp,
    assigned_by: 'owner@example.test', created_by: 'system', updated_by: 'system', metadata: {},
  };
}

test('capture hard-caps the stream, validates magic, and stores a private content-addressed object', async () => {
  const root = await testRoot();
  const storage = memoryStorage();
  const bytes = pdfBytes('one');
  const captured = await captureCimAttachment({
    metadata: metadata(),
    byteStream: streamBytes(bytes, 3),
    storage,
    quarantineRoot: root,
    maxBytes: bytes.length,
    now: new Date('2026-10-03T12:00:00.000Z'),
  });

  assert.equal(captured.lifecycle_status, 'scan-pending');
  assert.equal(captured.detected_mime_type, 'application/pdf');
  assert.equal(captured.size_bytes, bytes.length);
  assert.match(captured.sha256, /^[a-f0-9]{64}$/);
  assert.equal(captured.retention_status, 'hold');
  assert.equal(captured.retention_review_at, '2026-11-02T12:00:00.000Z');
  const stat = await fs.stat(path.join(root, captured.quarantine_path));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(path.join(root, captured.quarantine_path)), bytes);

  await assert.rejects(
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'too-big' }),
      byteStream: streamBytes(Buffer.concat([bytes, Buffer.from('x')]), 2),
      storage,
      quarantineRoot: root,
      maxBytes: bytes.length,
    }),
    /maximum size/i,
  );
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'fake-pdf' }),
      byteStream: streamBytes(Buffer.from('not really a pdf')),
      storage,
      quarantineRoot: root,
      maxBytes: 1024,
    }),
    /does not match/i,
  );
  async function* oversizedTypedChunk() {
    yield new Uint8Array(bytes.length + 1);
  }
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'oversized-typed-chunk' }),
      byteStream: oversizedTypedChunk(), storage, quarantineRoot: root, maxBytes: bytes.length,
    }),
    /maximum size/i,
  );
  async function* nonBinaryChunk() {
    yield 'not attachment bytes';
  }
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'non-binary-chunk' }),
      byteStream: nonBinaryChunk(), storage, quarantineRoot: root, maxBytes: 1024,
    }),
    /non-binary chunk/i,
  );
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.partial-')), false);
});

test('capture rejects before storage or provider bytes unless intake and scanner readiness are explicit', async () => {
  let storageTouched = false;
  let streamConsumed = false;
  const storage = {
    async getCimAttachmentIntakeByProviderAttachment() {
      storageTouched = true;
      throw new Error('storage must not be touched while intake is disabled');
    },
  };
  async function* providerBytes() {
    streamConsumed = true;
    yield pdfBytes('must-not-be-consumed');
  }

  for (const readiness of [
    undefined,
    {},
    { enabled: false, scannerReady: true },
    { enabled: 'true', scannerReady: true },
    { enabled: true, scannerReady: false },
    { enabled: true, scannerReady: 'true' },
  ]) {
    await assert.rejects(
      captureCimAttachmentWithGate({
        metadata: metadata(), byteStream: providerBytes(), storage, quarantineRoot: '/not-used',
        maxBytes: 1024, readiness,
      }),
      /intake is disabled|scanner is not ready/i,
    );
  }
  assert.equal(storageTouched, false);
  assert.equal(streamConsumed, false);
});

test('scan rejects before storage access unless scanner readiness is explicit', async () => {
  let storageTouched = false;
  const storage = {
    async getCimAttachmentIntake() {
      storageTouched = true;
      throw new Error('storage must not be touched while scanner is disabled');
    },
  };

  for (const readiness of [undefined, { scannerReady: false }, { scannerReady: 'true' }]) {
    await assert.rejects(
      scanCimAttachmentWithGate({
        intakeId: 'held-attachment', storage, quarantineRoot: '/not-used', readiness,
      }),
      /scanner is not ready/i,
    );
  }
  assert.equal(storageTouched, false);
});

test('deterministic test scanner fails closed unless a test chooses an outcome', async () => {
  const result = await createDeterministicFakeScanner().scan({ sha256: 'fixture-sha' });
  assert.deepEqual(result, { outcome: 'unavailable' });
});

test('capture enforces one hard elapsed-time bound and removes the partial', async () => {
  const root = await testRoot();
  const storage = memoryStorage();
  async function* slowStream() {
    await delay(40);
    yield pdfBytes('late');
  }
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata(), byteStream: slowStream(), storage, quarantineRoot: root,
      maxBytes: 1024, maxDurationMs: 5,
    }),
    /time limit/i,
  );
  assert.equal(storage.rows.size, 0);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.partial-')), false);
});

test('provider replay does not consume bytes and a content duplicate keeps distinct provenance without duplicate bytes', async () => {
  const root = await testRoot();
  const storage = memoryStorage();
  const bytes = pdfBytes('duplicate');
  const first = await captureCimAttachment({ metadata: metadata(), byteStream: streamBytes(bytes), storage, quarantineRoot: root, maxBytes: 1024 });
  async function* explodingStream() {
    yield Buffer.alloc(0);
    throw new Error('replay stream was consumed');
  }
  const replay = await captureCimAttachment({ metadata: metadata(), byteStream: explodingStream(), storage, quarantineRoot: root, maxBytes: 1024 });
  assert.equal(replay.id, first.id);

  const duplicate = await captureCimAttachment({
    metadata: metadata({ providerAttachmentId: 'attachment-2' }),
    byteStream: streamBytes(bytes),
    storage,
    quarantineRoot: root,
    maxBytes: 1024,
  });
  assert.notEqual(duplicate.id, first.id);
  assert.equal(duplicate.duplicate_of_id, first.id);
  assert.equal(duplicate.quarantine_path, first.quarantine_path);
  assert.equal((await fs.readdir(root)).filter((name) => !name.startsWith('.')).length, 1);
});

test('concurrent content duplicates converge on one canonical object and preserve both provenance rows', async () => {
  const root = await testRoot();
  const storage = memoryStorage();
  let shaLookups = 0;
  let releaseShaLookups;
  const shaLookupGate = new Promise((resolve) => { releaseShaLookups = resolve; });
  const racingStorage = {
    ...storage,
    async getCimAttachmentIntakeBySha256(sha256) {
      shaLookups += 1;
      if (shaLookups <= 2) {
        if (shaLookups === 2) releaseShaLookups();
        await shaLookupGate;
        return null;
      }
      return storage.getCimAttachmentIntakeBySha256(sha256);
    },
  };
  const bytes = pdfBytes('concurrent-duplicate');
  const [first, second] = await Promise.all([
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'race-1' }), byteStream: streamBytes(bytes, 2),
      storage: racingStorage, quarantineRoot: root, maxBytes: 1024,
    }),
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'race-2' }), byteStream: streamBytes(bytes, 3),
      storage: racingStorage, quarantineRoot: root, maxBytes: 1024,
    }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.equal(first.quarantine_path, second.quarantine_path);
  const rows = [...storage.rows.values()];
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.duplicate_of_id === null).length, 1);
  assert.equal(rows.filter((row) => row.duplicate_of_id !== null).length, 1);
  assert.equal((await fs.readdir(root)).filter((name) => !name.startsWith('.')).length, 1);
});

test('capture requires matching inbound communication provenance before consuming bytes', async () => {
  const root = await testRoot();
  async function* explodingStream() {
    yield Buffer.alloc(0);
    throw new Error('stream must not be consumed');
  }
  for (const communicationValue of [
    null,
    { id: 'comm-1', direction: 'outbound', provider: 'resend', provider_message_id: 'message-1' },
    { id: 'comm-1', direction: 'inbound', provider: 'gmail', provider_message_id: 'message-1' },
    { id: 'comm-1', direction: 'inbound', provider: 'resend', provider_message_id: 'another-message' },
  ]) {
    const storage = memoryStorage();
    storage.setCommunication(communicationValue);
    await assert.rejects(
      captureCimAttachment({ metadata: metadata(), byteStream: explodingStream(), storage, quarantineRoot: root, maxBytes: 1024 }),
      /inbound communication|provider provenance/i,
    );
    assert.equal(storage.rows.size, 0);
  }
});

test('capture insert ambiguity retains only a sweepable partial while quarantining rows recover without rereading bytes', async () => {
  const root = await testRoot();
  const bytes = pdfBytes('recovery');

  const insertFailureStorage = memoryStorage();
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata(), byteStream: streamBytes(bytes), quarantineRoot: root, maxBytes: 1024,
      storage: { ...insertFailureStorage, async insertCimAttachmentIntake() { throw new Error('database unavailable'); } },
    }),
    /database unavailable/i,
  );
  assert.equal(insertFailureStorage.rows.size, 0);
  const failedPartials = (await fs.readdir(root)).filter((name) => name.startsWith('.partial-'));
  assert.equal(failedPartials.length, 1);
  const old = new Date('2026-10-01T00:00:00.000Z');
  await fs.utimes(path.join(root, failedPartials[0]), old, old);
  const swept = await cleanupStaleCimAttachmentPartials({
    quarantineRoot: root, storage: insertFailureStorage,
    now: new Date('2026-10-03T00:00:00.000Z'), staleAfterMs: 60_000,
  });
  assert.deepEqual(swept.removed, failedPartials);

  const responseLostStorage = memoryStorage();
  const lostResponse = {
    ...responseLostStorage,
    async insertCimAttachmentIntake(row) {
      await responseLostStorage.insertCimAttachmentIntake(row);
      throw new Error('insert response lost');
    },
  };
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'lost' }), byteStream: streamBytes(bytes),
      storage: lostResponse, quarantineRoot: root, maxBytes: 1024,
    }),
    /response lost/i,
  );
  const quarantining = [...responseLostStorage.rows.values()][0];
  assert.equal(quarantining.lifecycle_status, 'quarantining');
  assert.equal((await fs.readdir(root)).includes(`.partial-${quarantining.id}`), true);
  const restart = await cleanupStaleCimAttachmentPartials({
    quarantineRoot: root, storage: responseLostStorage, now: new Date('2026-10-03T12:05:00.000Z'),
  });
  assert.deepEqual(restart.recovered, [quarantining.id]);
  async function* noReplayRead() {
    yield Buffer.alloc(0);
    throw new Error('recovery reread provider bytes');
  }
  const recovered = await captureCimAttachment({
    metadata: metadata({ providerAttachmentId: 'lost' }), byteStream: noReplayRead(),
    storage: responseLostStorage, quarantineRoot: root, maxBytes: 1024,
  });
  assert.equal(recovered.lifecycle_status, 'scan-pending');
  assert.deepEqual(await fs.readFile(path.join(root, recovered.quarantine_path)), bytes);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.partial-')), false);

  const transitionFailureStorage = memoryStorage();
  let failTransition = true;
  const interruptedTransition = {
    ...transitionFailureStorage,
    async updateCimAttachmentIntake(id, values, options) {
      if (failTransition && options?.expectedStatus === 'quarantining') {
        failTransition = false;
        throw new Error('crash after canonical link');
      }
      return transitionFailureStorage.updateCimAttachmentIntake(id, values, options);
    },
  };
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'link-crash' }), byteStream: streamBytes(pdfBytes('link-crash')),
      storage: interruptedTransition, quarantineRoot: root, maxBytes: 1024,
    }),
    /crash after canonical link/i,
  );
  const pendingRecovery = [...transitionFailureStorage.rows.values()][0];
  assert.equal(pendingRecovery.lifecycle_status, 'quarantining');
  const linkedRecovered = await captureCimAttachment({
    metadata: metadata({ providerAttachmentId: 'link-crash' }), byteStream: noReplayRead(),
    storage: transitionFailureStorage, quarantineRoot: root, maxBytes: 1024,
  });
  assert.equal(linkedRecovered.lifecycle_status, 'scan-pending');

  const omittedStorage = memoryStorage();
  const omittedResponse = {
    ...omittedStorage,
    async insertCimAttachmentIntake(row) {
      await omittedStorage.insertCimAttachmentIntake(row);
      throw new Error('insert response lost beyond list limit');
    },
  };
  await assert.rejects(
    captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'omitted' }), byteStream: streamBytes(pdfBytes('omitted')),
      storage: omittedResponse, quarantineRoot: root, maxBytes: 1024,
    }),
    /beyond list limit/i,
  );
  const omitted = [...omittedStorage.rows.values()][0];
  const omittedPartial = path.join(root, `.partial-${omitted.id}`);
  await fs.utimes(omittedPartial, old, old);
  const omittedFromList = { ...omittedStorage, async listCimAttachmentIntakes() { return []; } };
  const omittedRecovery = await cleanupStaleCimAttachmentPartials({
    quarantineRoot: root, storage: omittedFromList,
    now: new Date('2026-10-03T00:00:00.000Z'), staleAfterMs: 60_000,
  });
  assert.deepEqual(omittedRecovery.recovered, [omitted.id]);
  assert.equal((await omittedStorage.getCimAttachmentIntake(omitted.id)).lifecycle_status, 'scan-pending');
  assert.deepEqual(await fs.readFile(path.join(root, omitted.quarantine_path)), pdfBytes('omitted'));
});

test('capture propagates a disk-full stream failure without leaving bytes or lifecycle state', async () => {
  const root = await testRoot();
  const storage = memoryStorage();
  async function* diskFullStream() {
    yield pdfBytes('partial');
    throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
  }
  await assert.rejects(
    captureCimAttachment({ metadata: metadata(), byteStream: diskFullStream(), storage, quarantineRoot: root, maxBytes: 1024 }),
    /disk full/i,
  );
  assert.equal(storage.rows.size, 0);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.partial-')), false);
});

test('quarantine and vault paths reject symbolic links and lexical escapes', async () => {
  const parent = await testRoot();
  const outside = path.join(parent, 'outside');
  const linkedRoot = path.join(parent, 'linked-quarantine');
  await fs.mkdir(outside);
  await fs.symlink(outside, linkedRoot);
  await assert.rejects(
    captureCimAttachment({ metadata: metadata(), byteStream: streamBytes(pdfBytes()), storage: memoryStorage(), quarantineRoot: linkedRoot, maxBytes: 1024 }),
    /symbolic link/i,
  );

  const quarantineRoot = path.join(parent, 'quarantine');
  const storage = memoryStorage();
  const captured = await captureCimAttachment({ metadata: metadata(), byteStream: streamBytes(pdfBytes('symlink')), storage, quarantineRoot, maxBytes: 1024 });
  const canonicalPath = path.join(quarantineRoot, captured.quarantine_path);
  const outsideFile = path.join(outside, 'outside.pdf');
  await fs.writeFile(outsideFile, pdfBytes('symlink'));
  await fs.unlink(canonicalPath);
  await fs.symlink(outsideFile, canonicalPath);
  await assert.rejects(
    scanCimAttachment({ intakeId: captured.id, storage, quarantineRoot, scanner: createDeterministicFakeScanner() }),
    /symbolic link/i,
  );
  storage.rows.get(captured.id).quarantine_path = '../outside/outside.pdf';
  await assert.rejects(
    scanCimAttachment({ intakeId: captured.id, storage, quarantineRoot, scanner: createDeterministicFakeScanner() }),
    /outside.*owned storage root/i,
  );
});

test('fake scanner records clean, unsafe, and bounded unavailable outcomes without publishing', async () => {
  const root = await testRoot();
  const storage = memoryStorage();
  const clean = await captureCimAttachment({ metadata: metadata(), byteStream: streamBytes(pdfBytes()), storage, quarantineRoot: root, maxBytes: 1024 });
  const scanned = await scanCimAttachment({
    intakeId: clean.id,
    storage,
    quarantineRoot: root,
    scanner: createDeterministicFakeScanner({ defaultOutcome: 'clean' }),
    now: new Date('2026-10-03T13:00:00.000Z'),
  });
  assert.equal(scanned.lifecycle_status, 'awaiting-owner-approval');
  assert.equal(scanned.scan_status, 'clean');
  assert.equal(storage.documents.size, 0);

  const unsafe = await captureCimAttachment({ metadata: metadata({ providerAttachmentId: 'unsafe' }), byteStream: streamBytes(pdfBytes('unsafe')), storage, quarantineRoot: root, maxBytes: 1024 });
  const unsafeResult = await scanCimAttachment({ intakeId: unsafe.id, storage, quarantineRoot: root, scanner: createDeterministicFakeScanner({ outcomesBySha256: { [unsafe.sha256]: 'unsafe' } }) });
  assert.equal(unsafeResult.lifecycle_status, 'unsafe');
  assert.equal(unsafeResult.hold_reason, 'unsafe');
  await assert.rejects(
    publishApprovedCimAttachment({ intakeId: unsafe.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage, quarantineRoot: root, vaultRoot: path.join(root, 'vault') }),
    /clean scan/i,
  );

  const unavailable = await captureCimAttachment({ metadata: metadata({ providerAttachmentId: 'unavailable' }), byteStream: streamBytes(pdfBytes('unavailable')), storage, quarantineRoot: root, maxBytes: 1024 });
  let scanCalls = 0;
  const unavailableScanner = {
    name: 'counting-fake', version: '1',
    async scan() { scanCalls += 1; return { outcome: 'unavailable' }; },
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await scanCimAttachment({
      intakeId: unavailable.id,
      storage,
      quarantineRoot: root,
      scanner: unavailableScanner,
      now: new Date(`2026-10-0${attempt + 3}T00:00:00.000Z`),
    });
    assert.equal(result.scan_attempt_count, attempt);
    assert.equal(Boolean(result.next_scan_at), attempt < 3);
    assert.equal(result.hold_reason, attempt < 3 ? 'scan_unavailable' : 'retry_exhausted');
    if (attempt === 1) {
      await assert.rejects(
        scanCimAttachment({
          intakeId: unavailable.id, storage, quarantineRoot: root, scanner: unavailableScanner,
          now: new Date('2026-10-04T00:05:00.000Z'),
        }),
        /retry is not due/i,
      );
      assert.equal(scanCalls, 1);
    }
  }
});

test('owner publication rejects absent or wrong assignment and resumes an existing vault file idempotently', async () => {
  const root = await testRoot();
  const quarantineRoot = path.join(root, 'quarantine');
  const vaultRoot = path.join(root, 'vault');
  const storage = memoryStorage({ communicationSubmissionId: null });
  const captured = await captureCimAttachment({ metadata: metadata(), byteStream: streamBytes(pdfBytes()), storage, quarantineRoot, maxBytes: 1024 });
  await scanCimAttachment({ intakeId: captured.id, storage, quarantineRoot, scanner: createDeterministicFakeScanner({ defaultOutcome: 'clean' }) });
  await seedSyntheticPublicationVerdict(storage, captured.id);

  for (const documentType of [undefined, 'invented-type']) {
    await assert.rejects(
      publishApprovedCimAttachment({
        intakeId: captured.id, submissionId: 'submission-1', documentType,
        actor: 'owner@example.test', storage, quarantineRoot, vaultRoot,
      }),
      /explicit recognized document type/i,
    );
  }
  assert.equal(storage.documents.size, 0);

  await assert.rejects(
    publishApprovedCimAttachment({ intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage, quarantineRoot, vaultRoot }),
    /assigned/i,
  );
  assert.equal((await storage.getCimAttachmentIntake(captured.id)).hold_reason, 'assignment_ambiguous');
  storage.setCommunication({ id: 'comm-1', direction: 'inbound', submission_id: 'submission-2', provider: 'resend', provider_message_id: 'message-1' });
  await assert.rejects(
    publishApprovedCimAttachment({ intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage, quarantineRoot, vaultRoot }),
    /another business/i,
  );
  assert.equal((await storage.getCimAttachmentIntake(captured.id)).hold_reason, 'wrong_business');

  storage.setCommunication({ id: 'comm-1', direction: 'inbound', submission_id: 'submission-1', provider: 'resend', provider_message_id: 'message-1' });
  const published = await publishApprovedCimAttachment({ intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage, quarantineRoot, vaultRoot, now: new Date('2026-10-03T15:00:00.000Z') });
  assert.equal(published.lifecycle_status, 'published');
  assert.equal(storage.documents.size, 1);
  const replay = await publishApprovedCimAttachment({ intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage, quarantineRoot, vaultRoot });
  assert.equal(replay.vault_document_id, published.vault_document_id);
  assert.equal(storage.documents.size, 1);
});

test('disk-full publication remains retryable and leaves no vault partial', async () => {
  const root = await testRoot();
  const quarantineRoot = path.join(root, 'quarantine');
  const vaultRoot = path.join(root, 'vault');
  const storage = memoryStorage();
  const captured = await captureCimAttachment({ metadata: metadata(), byteStream: streamBytes(pdfBytes()), storage, quarantineRoot, maxBytes: 1024 });
  await scanCimAttachment({ intakeId: captured.id, storage, quarantineRoot, scanner: createDeterministicFakeScanner({ defaultOutcome: 'clean' }) });
  await seedSyntheticPublicationVerdict(storage, captured.id);
  const diskFull = Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
  await assert.rejects(
    publishApprovedCimAttachment({
      intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim',
      actor: 'owner@example.test', storage, quarantineRoot, vaultRoot,
      copyFile: async () => { throw diskFull; },
    }),
    /disk full/i,
  );
  assert.equal((await storage.getCimAttachmentIntake(captured.id)).lifecycle_status, 'publishing');
  const vaultEntries = await fs.readdir(vaultRoot, { recursive: true }).catch(() => []);
  assert.equal(vaultEntries.some((entry) => String(entry).includes('.partial-')), false);
  await assert.rejects(
    publishApprovedCimAttachment({
      intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim',
      actor: 'owner@example.test', storage, quarantineRoot, vaultRoot,
      copyFile: async (_sourceHandle, destinationHandle) => {
        await destinationHandle.write(Buffer.from('tampered copy'));
      },
    }),
    /copy failed integrity/i,
  );
  const tamperEntries = await fs.readdir(vaultRoot, { recursive: true }).catch(() => []);
  assert.equal(tamperEntries.some((entry) => String(entry).includes('.partial-')), false);
  const published = await publishApprovedCimAttachment({
    intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim',
    actor: 'owner@example.test', storage, quarantineRoot, vaultRoot,
  });
  assert.equal(published.lifecycle_status, 'published');
});

test('restart cleanup removes only stale owned partial files', async () => {
  const root = await testRoot();
  const storage = memoryStorage();
  const stale = path.join(root, '.partial-stale');
  const live = path.join(root, '.partial-live');
  const lifecycle = path.join(root, 'kept.pdf');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all([fs.writeFile(stale, 'stale'), fs.writeFile(live, 'live'), fs.writeFile(lifecycle, 'kept')]);
  const old = new Date('2026-10-01T00:00:00.000Z');
  await fs.utimes(stale, old, old);
  await assert.rejects(
    cleanupStaleCimAttachmentPartials({ quarantineRoot: root }),
    /requires lifecycle storage authority/i,
  );
  const result = await cleanupStaleCimAttachmentPartials({
    quarantineRoot: root, storage, now: new Date('2026-10-03T00:00:00.000Z'), staleAfterMs: 60_000,
  });
  assert.deepEqual(result, { removed: ['.partial-stale'], recovered: [] });
  assert.equal(await fs.readFile(live, 'utf8'), 'live');
  assert.equal(await fs.readFile(lifecycle, 'utf8'), 'kept');
});

test('SQLite publication is atomic and only the resulting vault document changes materials authority', async () => {
  const root = await testRoot();
  const quarantineRoot = path.join(root, 'quarantine');
  const vaultRoot = path.join(root, 'vault');
  const storage = createSqliteStorage({
    storage: { sqlitePath: path.join(root, 'application.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
  });
  try {
    await storage.insertSubmission(submission());
    await storage.insertCrmCommunication(communication());
    const captured = await captureCimAttachment({ metadata: metadata(), byteStream: streamBytes(pdfBytes()), storage, quarantineRoot, maxBytes: 1024 });
    await scanCimAttachment({ intakeId: captured.id, storage, quarantineRoot, scanner: createDeterministicFakeScanner({ defaultOutcome: 'clean' }) });
    await seedSyntheticPublicationVerdict(storage, captured.id);
    assert.equal(evaluateAcquisitionMaterialsState({ submission: submission(), secureDocuments: [] }).materialsReceived, false);

    let failBeforeCommit = true;
    const interruptedStorage = {
      ...storage,
      async publishCimAttachmentToVault(input) {
        if (failBeforeCommit) {
          failBeforeCommit = false;
          throw new Error('simulated crash before database commit');
        }
        return storage.publishCimAttachmentToVault(input);
      },
    };
    await assert.rejects(
      publishApprovedCimAttachment({ intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage: interruptedStorage, quarantineRoot, vaultRoot }),
      /simulated crash/,
    );
    assert.equal((await storage.listSecureDocumentsForSubmission('submission-1')).length, 0);
    const published = await publishApprovedCimAttachment({ intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage, quarantineRoot, vaultRoot });
    assert.equal(published.lifecycle_status, 'published');
    const documents = await storage.listSecureDocumentsForSubmission('submission-1');
    assert.equal(documents.length, 1);
    assert.equal(evaluateAcquisitionMaterialsState({ submission: submission(), secureDocuments: documents }).materialsReceived, true);

    const second = await captureCimAttachment({
      metadata: metadata({ providerAttachmentId: 'commit-response-lost' }),
      byteStream: streamBytes(pdfBytes('commit-response-lost')), storage, quarantineRoot, maxBytes: 1024,
    });
    await scanCimAttachment({ intakeId: second.id, storage, quarantineRoot, scanner: createDeterministicFakeScanner({ defaultOutcome: 'clean' }) });
    await seedSyntheticPublicationVerdict(storage, second.id);
    const responseLostStorage = {
      ...storage,
      async publishCimAttachmentToVault(input) {
        await storage.publishCimAttachmentToVault(input);
        throw new Error('simulated response lost after database commit');
      },
    };
    await assert.rejects(
      publishApprovedCimAttachment({ intakeId: second.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage: responseLostStorage, quarantineRoot, vaultRoot }),
      /response lost/,
    );
    const recoveredCommitted = await publishApprovedCimAttachment({ intakeId: second.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage, quarantineRoot, vaultRoot });
    assert.equal(recoveredCommitted.lifecycle_status, 'published');
    assert.equal((await storage.listSecureDocumentsForSubmission('submission-1')).length, 2);

    const reopened = createSqliteStorage({ storage: { sqlitePath: path.join(root, 'application.sqlite') }, protection: { rateLimitRetentionMs: 0 } });
    try {
      const replay = await publishApprovedCimAttachment({ intakeId: captured.id, submissionId: 'submission-1', documentType: 'cim', actor: 'owner@example.test', storage: reopened, quarantineRoot, vaultRoot });
      assert.equal(replay.vault_document_id, published.vault_document_id);
      assert.equal((await reopened.listSecureDocumentsForSubmission('submission-1')).length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    storage.close();
  }
});

test('backup verifies, restores, and detects tampering of held quarantine objects', async () => {
  const root = await testRoot();
  const config = {
    storage: { provider: 'sqlite', sqlitePath: path.join(root, 'source.sqlite') },
    protection: { rateLimitRetentionMs: 0 },
    secureDocuments: {
      storageDir: path.join(root, 'secure-documents'),
      quarantineDir: path.join(root, 'quarantine'),
    },
    backup: {
      directory: path.join(root, 'backups'), retentionDays: 30, retentionCount: 2,
      time: '03:30', timezone: 'America/Los_Angeles', checkIntervalMs: 900000,
    },
  };
  const storage = createSqliteStorage(config);
  try {
    await storage.insertSubmission(submission());
    await storage.insertCrmCommunication(communication());
    const captured = await captureCimAttachment({
      metadata: metadata(), byteStream: streamBytes(pdfBytes('backup')), storage,
      quarantineRoot: config.secureDocuments.quarantineDir, maxBytes: 1024,
    });
    const sourceDocumentDirectory = path.join(config.secureDocuments.storageDir, 'request-collision');
    const sourceDocumentPath = path.join(sourceDocumentDirectory, 'financials.txt');
    await fs.mkdir(sourceDocumentDirectory, { recursive: true });
    await fs.writeFile(sourceDocumentPath, 'backup restore collision fixture');
    await storage.insertSecureDocument({
      id: 'document-collision', request_id: 'request-collision', submission_id: 'submission-1',
      created_at: '2026-10-03T15:59:00.000Z', document_type: 'financials',
      file_name: 'financials.txt', original_name: 'financials.txt', mime_type: 'text/plain',
      size_bytes: Buffer.byteLength('backup restore collision fixture'), storage_path: sourceDocumentPath,
      uploaded_by_email: 'owner@example.test', note: '', nda_accepted_at: null,
    });
    const backup = await createBackupBundle({ storage, config, now: new Date('2026-10-03T16:00:00.000Z') });
    assert.equal(backup.manifest.quarantinedAttachments.count, 1);
    assert.deepEqual(backup.manifest.quarantinedAttachments.files[0].intakeIds, [captured.id]);
    assert.equal((await verifyBackupBundle(backup.path)).ok, true);

    const restoredDatabase = path.join(root, 'restored', 'application.sqlite');
    const restoredQuarantine = path.join(root, 'restored', 'quarantine');
    const restore = await restoreBackupBundle(backup.path, {
      databasePath: restoredDatabase,
      documentsDirectory: path.join(root, 'restored', 'documents'),
      quarantineDirectory: restoredQuarantine,
    });
    assert.equal(restore.restoredQuarantinedAttachments, 1);
    const restored = createSqliteStorage({ storage: { sqlitePath: restoredDatabase }, protection: { rateLimitRetentionMs: 0 } });
    try {
      const restoredIntake = await restored.getCimAttachmentIntake(captured.id);
      assert.equal(restoredIntake.retention_status, 'hold');
      assert.deepEqual(await fs.readFile(path.join(restoredQuarantine, restoredIntake.quarantine_path)), pdfBytes('backup'));
    } finally {
      restored.close();
    }

    const nestedRestoreDatabase = path.join(root, 'nested-restore', 'application.sqlite');
    const nestedRestoreDocuments = path.join(root, 'nested-restore', 'secure-documents');
    const nestedRestoreQuarantine = path.join(nestedRestoreDocuments, '.cim-attachment-quarantine');
    const nestedRestore = await restoreBackupBundle(backup.path, {
      databasePath: nestedRestoreDatabase,
      documentsDirectory: nestedRestoreDocuments,
      quarantineDirectory: nestedRestoreQuarantine,
    });
    assert.equal(nestedRestore.ok, true);
    const nestedDatabase = createSqliteStorage({
      storage: { sqlitePath: nestedRestoreDatabase }, protection: { rateLimitRetentionMs: 0 },
    });
    try {
      const nestedIntake = await nestedDatabase.getCimAttachmentIntake(captured.id);
      assert.deepEqual(
        await fs.readFile(path.join(nestedRestoreQuarantine, nestedIntake.quarantine_path)),
        pdfBytes('backup'),
      );
    } finally {
      nestedDatabase.close();
    }

    const rollbackDocuments = path.join(root, 'rollback', 'secure-documents');
    const rollbackQuarantine = path.join(rollbackDocuments, '.cim-attachment-quarantine');
    const heldBeforeRestore = path.join(rollbackQuarantine, 'existing-held-object');
    const rollbackDatabase = path.join(root, 'rollback', 'application.sqlite');
    await fs.mkdir(rollbackQuarantine, { recursive: true });
    await fs.writeFile(heldBeforeRestore, 'must survive failed restore');
    const renameFile = fs.rename;
    fs.rename = async (source, destination) => {
      if (path.resolve(destination) === path.resolve(rollbackDatabase)
        && path.basename(source) === 'database.sqlite') {
        throw Object.assign(new Error('simulated database install disk full'), { code: 'ENOSPC' });
      }
      return renameFile(source, destination);
    };
    try {
      await assert.rejects(
        restoreBackupBundle(backup.path, {
          databasePath: rollbackDatabase,
          documentsDirectory: rollbackDocuments,
          quarantineDirectory: rollbackQuarantine,
          overwrite: true,
        }),
        /disk full/i,
      );
    } finally {
      fs.rename = renameFile;
    }
    assert.equal(await fs.readFile(heldBeforeRestore, 'utf8'), 'must survive failed restore');

    const backedUpObject = path.join(backup.path, backup.manifest.quarantinedAttachments.files[0].relativePath);
    const incompleteBundle = `${backup.path}-missing-quarantine-manifest`;
    await fs.cp(backup.path, incompleteBundle, { recursive: true });
    const incompleteManifestPath = path.join(incompleteBundle, 'manifest.json');
    const incompleteManifest = JSON.parse(await fs.readFile(incompleteManifestPath, 'utf8'));
    delete incompleteManifest.quarantinedAttachments;
    await fs.writeFile(incompleteManifestPath, `${JSON.stringify(incompleteManifest, null, 2)}\n`);
    await fs.rm(path.join(incompleteBundle, 'quarantine'), { recursive: true, force: true });
    const missingSection = await verifyBackupBundle(incompleteBundle);
    assert.equal(missingSection.ok, false);
    assert.ok(missingSection.errors.some((error) => /manifest section is required/i.test(error)));

    const symlinkBundle = `${backup.path}-symlink-quarantine`;
    await fs.cp(backup.path, symlinkBundle, { recursive: true });
    const symlinkManifest = JSON.parse(await fs.readFile(path.join(symlinkBundle, 'manifest.json'), 'utf8'));
    const symlinkObject = path.join(symlinkBundle, symlinkManifest.quarantinedAttachments.files[0].relativePath);
    const outsideObject = path.join(root, 'outside-quarantine-object.pdf');
    await fs.copyFile(symlinkObject, outsideObject);
    await fs.unlink(symlinkObject);
    await fs.symlink(outsideObject, symlinkObject);
    const symlinkVerification = await verifyBackupBundle(symlinkBundle);
    assert.equal(symlinkVerification.ok, false);
    assert.ok(symlinkVerification.errors.some((error) => /symbolic link/i.test(error)));

    await fs.appendFile(backedUpObject, 'tampered');
    const tampered = await verifyBackupBundle(backup.path);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.errors.some((error) => /quarantined attachment.*(size|checksum)/i.test(error)));
  } finally {
    storage.close();
  }
});
