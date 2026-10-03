import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  normalizeSecureDocumentType,
  sanitizeSecureDocumentFileName,
  secureDocumentAllowedMimeTypes,
  secureDocumentBufferMatchesMimeType,
} from './documentVault.js';

const maximumMetadataLength = 500;
const magicInspectionBytes = 4096;
const retentionReviewMs = 30 * 24 * 60 * 60 * 1000;
const retryDelaysMs = [15 * 60 * 1000, 2 * 60 * 60 * 1000];
const maximumScanAttempts = 3;
const defaultCaptureDurationMs = 30_000;
const allowedDocumentTypes = new Set([
  'teaser', 'cim', 'nda', 'financials', 'p_and_l', 'tax_returns', 'balance_sheet',
  'customer_concentration', 'payroll', 'lease', 'contracts', 'equipment', 'owner_role',
  'management_depth', 'sba_fit', 'other',
]);
const allowedDocumentTypeAliases = new Set(['tax-returns', 'customer-summary', 'p&l']);

function boundedIdentifier(value, label) {
  const normalized = String(value || '').trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > maximumMetadataLength || hasControlCharacter) {
    throw new Error(`${label} must be a bounded non-empty identifier.`);
  }
  return normalized;
}

function isoNow(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('A valid attachment lifecycle time is required.');
  return date.toISOString();
}

function ownedPath(root, relativePath) {
  if (!String(root || '').trim()) throw new Error('Attachment storage root is required.');
  const resolvedRoot = path.resolve(String(root));
  const candidate = path.resolve(resolvedRoot, String(relativePath || ''));
  if (!resolvedRoot || candidate === resolvedRoot || !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Attachment path is outside its owned storage root.');
  }
  return candidate;
}

async function ensureOwnedRoot(root, { create = false } = {}) {
  const resolvedRoot = path.resolve(String(root || ''));
  if (!String(root || '').trim()) throw new Error('Attachment storage root is required.');
  if (create) await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(resolvedRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Attachment storage root must be a real directory, not a symbolic link.');
  }
  return { resolvedRoot, realRoot: await fs.realpath(resolvedRoot) };
}

function assertRealPathOwned(realRoot, realCandidate) {
  if (realCandidate === realRoot || !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('Attachment path is outside its owned storage root.');
  }
}

async function assertOwnedRegularFile(root, relativePath) {
  const { realRoot } = await ensureOwnedRoot(root);
  const candidate = ownedPath(root, relativePath);
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Attachment object must be a regular file, not a symbolic link.');
  }
  assertRealPathOwned(realRoot, await fs.realpath(candidate));
  return { candidate, stat };
}

async function ensureOwnedDirectory(root, relativeDirectory = '') {
  const { resolvedRoot, realRoot } = await ensureOwnedRoot(root, { create: true });
  const destination = relativeDirectory ? ownedPath(resolvedRoot, relativeDirectory) : resolvedRoot;
  const relative = path.relative(resolvedRoot, destination);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Attachment storage directory must not contain symbolic links.');
    }
    assertRealPathOwned(realRoot, await fs.realpath(current));
  }
  return destination;
}

function extensionForMime(mimeType, originalName = '') {
  const preferred = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-excel': '.xls',
    'text/csv': '.csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/msword': '.doc',
    'text/plain': '.txt',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
  }[mimeType];
  return preferred || path.extname(sanitizeSecureDocumentFileName(originalName)).slice(0, 12) || '.bin';
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function hashOwnedFile(root, relativePath) {
  const { candidate: filePath } = await assertOwnedRegularFile(root, relativePath);
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { sha256: hash.digest('hex'), size };
  } finally {
    await handle.close();
  }
}

function partialName(intakeId) {
  return `.partial-${intakeId}`;
}

async function finalizeQuarantinedObject({ intake, storage, quarantineRoot, now = new Date() }) {
  await ensureOwnedRoot(quarantineRoot);
  const temporaryRelativePath = partialName(intake.id);
  const temporaryPath = ownedPath(quarantineRoot, temporaryRelativePath);
  const finalPath = ownedPath(quarantineRoot, intake.quarantine_path);
  let finalIdentity;
  try {
    finalIdentity = await hashOwnedFile(quarantineRoot, intake.quarantine_path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporaryIdentity = await hashOwnedFile(quarantineRoot, temporaryRelativePath);
    if (temporaryIdentity.sha256 !== intake.sha256 || temporaryIdentity.size !== Number(intake.size_bytes)) {
      throw new Error('Partial quarantine object failed integrity validation.');
    }
    try {
      await fs.link(temporaryPath, finalPath);
    } catch (linkError) {
      if (linkError.code !== 'EEXIST') throw linkError;
    }
    finalIdentity = await hashOwnedFile(quarantineRoot, intake.quarantine_path);
  }
  if (finalIdentity.sha256 !== intake.sha256 || finalIdentity.size !== Number(intake.size_bytes)) {
    throw new Error('Quarantined attachment failed integrity validation.');
  }
  await fs.chmod(finalPath, 0o600);
  await safeUnlink(temporaryPath);
  const updated = await storage.updateCimAttachmentIntake(intake.id, {
    lifecycle_status: 'scan-pending',
    updated_at: isoNow(now),
  }, { expectedStatus: 'quarantining' });
  return updated || storage.getCimAttachmentIntake(intake.id);
}

export async function recoverCimAttachmentIntake({ intake, storage, quarantineRoot, now = new Date() } = {}) {
  const current = intake || null;
  if (!current || current.lifecycle_status !== 'quarantining') return current;
  return finalizeQuarantinedObject({ intake: current, storage, quarantineRoot, now });
}

function normalizeCaptureMetadata(metadata = {}) {
  const fileName = sanitizeSecureDocumentFileName(metadata.fileName || metadata.name || 'attachment');
  const declaredMimeType = String(metadata.declaredMimeType || metadata.mimeType || '').trim().toLowerCase();
  if (!secureDocumentAllowedMimeTypes.has(declaredMimeType)) {
    throw new Error('Attachment uses a file type that is not allowed.');
  }
  return {
    communicationId: boundedIdentifier(metadata.communicationId, 'Communication id'),
    provider: boundedIdentifier(metadata.provider, 'Provider').toLowerCase(),
    providerMessageId: boundedIdentifier(metadata.providerMessageId, 'Provider message id'),
    providerAttachmentId: boundedIdentifier(metadata.providerAttachmentId, 'Provider attachment id'),
    fileName,
    declaredMimeType,
  };
}

async function readStreamChunk(iterator, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Attachment capture exceeded its hard time limit.');
  let timer;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Attachment capture exceeded its hard time limit.')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeBoundedStream({ byteStream, temporaryPath, maxBytes, maxDurationMs }) {
  if (!byteStream || typeof byteStream[Symbol.asyncIterator] !== 'function') {
    throw new Error('Attachment byte stream must be an async iterable.');
  }
  const maximum = Number(maxBytes);
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Attachment maximum size must be a positive integer.');
  const maximumDuration = Number(maxDurationMs);
  if (!Number.isSafeInteger(maximumDuration) || maximumDuration < 1) {
    throw new Error('Attachment capture time limit must be a positive integer.');
  }
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  const iterator = byteStream[Symbol.asyncIterator]();
  const deadline = Date.now() + maximumDuration;
  const hash = createHash('sha256');
  const inspection = [];
  let inspectionLength = 0;
  let size = 0;
  try {
    while (true) {
      const next = await readStreamChunk(iterator, deadline);
      if (next.done) break;
      const value = next.value;
      let chunkLength;
      if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) chunkLength = value.byteLength;
      else if (value instanceof ArrayBuffer) chunkLength = value.byteLength;
      else throw new Error('Attachment byte stream yielded a non-binary chunk.');
      if (chunkLength > maximum - size) {
        throw new Error(`Attachment exceeds the maximum size of ${maximum} bytes.`);
      }
      const chunk = Buffer.isBuffer(value)
        ? value
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : Buffer.from(value);
      size += chunkLength;
      if (inspectionLength < magicInspectionBytes) {
        const prefix = chunk.subarray(0, magicInspectionBytes - inspectionLength);
        inspection.push(prefix);
        inspectionLength += prefix.length;
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (size === 0) throw new Error('Attachment is empty.');
    await handle.sync();
    return { size, sha256: hash.digest('hex'), inspection: Buffer.concat(inspection) };
  } catch (error) {
    if (typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

export async function captureCimAttachment({
  metadata,
  byteStream,
  storage,
  quarantineRoot,
  maxBytes,
  maxDurationMs = defaultCaptureDurationMs,
  now = new Date(),
} = {}) {
  const input = normalizeCaptureMetadata(metadata);
  const communication = await storage.getCrmCommunication(input.communicationId);
  if (!communication || communication.direction !== 'inbound') {
    throw new Error('Attachment must belong to an existing inbound communication.');
  }
  if (String(communication.provider || '').trim().toLowerCase() !== input.provider
    || String(communication.provider_message_id || '').trim() !== input.providerMessageId) {
    throw new Error('Attachment provider provenance does not match its inbound communication.');
  }
  const existing = await storage.getCimAttachmentIntakeByProviderAttachment(
    input.provider,
    input.providerMessageId,
    input.providerAttachmentId,
  );
  if (existing) {
    return existing.lifecycle_status === 'quarantining'
      ? recoverCimAttachmentIntake({ intake: existing, storage, quarantineRoot, now })
      : existing;
  }

  const capturedAt = isoNow(now);
  await ensureOwnedRoot(quarantineRoot, { create: true });
  await fs.chmod(quarantineRoot, 0o700);
  const intakeId = randomUUID();
  const temporaryName = partialName(intakeId);
  const temporaryPath = ownedPath(quarantineRoot, temporaryName);
  let persisted = false;
  let insertAttempted = false;
  try {
    const streamResult = await writeBoundedStream({ byteStream, temporaryPath, maxBytes, maxDurationMs });
    if (!secureDocumentBufferMatchesMimeType(streamResult.inspection, input.declaredMimeType)) {
      throw new Error(`${input.fileName} does not match the selected file type.`);
    }

    const canonical = await storage.getCimAttachmentIntakeBySha256(streamResult.sha256);
    const relativePath = canonical?.quarantine_path
      || `${streamResult.sha256}${extensionForMime(input.declaredMimeType, input.fileName)}`;
    if (canonical) {
      const recoveredCanonical = canonical.lifecycle_status === 'quarantining'
        ? await recoverCimAttachmentIntake({ intake: canonical, storage, quarantineRoot, now })
        : canonical;
      const identity = await hashOwnedFile(quarantineRoot, recoveredCanonical.quarantine_path);
      if (identity.sha256 !== streamResult.sha256 || identity.size !== streamResult.size) {
        throw new Error('Existing quarantine duplicate failed integrity validation.');
      }
    }

    const row = {
      id: intakeId,
      communication_id: input.communicationId,
      provider: input.provider,
      provider_message_id: input.providerMessageId,
      provider_attachment_id: input.providerAttachmentId,
      original_file_name: input.fileName,
      declared_mime_type: input.declaredMimeType,
      detected_mime_type: input.declaredMimeType,
      size_bytes: streamResult.size,
      sha256: streamResult.sha256,
      quarantine_path: relativePath,
      duplicate_of_id: canonical?.id || null,
      lifecycle_status: 'quarantining',
      scan_status: 'pending',
      scan_attempt_count: 0,
      scanner_name: null,
      scanner_version: null,
      scan_last_error: null,
      next_scan_at: null,
      hold_reason: null,
      owner_approved_at: null,
      owner_approved_by: null,
      approved_submission_id: null,
      approved_document_type: null,
      vault_request_id: null,
      vault_document_id: null,
      vault_relative_path: null,
      published_at: null,
      retention_status: 'hold',
      retention_review_at: new Date(Date.parse(capturedAt) + retentionReviewMs).toISOString(),
      created_at: capturedAt,
      updated_at: capturedAt,
    };
    insertAttempted = true;
    let inserted = await storage.insertCimAttachmentIntake(row);
    if (inserted.id !== intakeId) {
      await safeUnlink(temporaryPath);
      return inserted.lifecycle_status === 'quarantining'
        ? recoverCimAttachmentIntake({ intake: inserted, storage, quarantineRoot, now })
        : inserted;
    }
    const convergedCanonical = await storage.getCimAttachmentIntakeBySha256(streamResult.sha256);
    if (convergedCanonical && convergedCanonical.id !== inserted.id && !inserted.duplicate_of_id) {
      inserted = await storage.updateCimAttachmentIntake(inserted.id, {
        duplicate_of_id: convergedCanonical.id,
        updated_at: capturedAt,
      }, { expectedStatus: 'quarantining' }) || inserted;
    }
    persisted = true;
    return await finalizeQuarantinedObject({ intake: inserted, storage, quarantineRoot, now });
  } catch (error) {
    if (!persisted) {
      const recovered = await storage.getCimAttachmentIntakeByProviderAttachment(
        input.provider, input.providerMessageId, input.providerAttachmentId,
      ).catch(() => null);
      if (recovered?.id === intakeId) persisted = true;
    }
    if (!persisted && !insertAttempted) await safeUnlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export function createDeterministicFakeScanner({ defaultOutcome = 'clean', outcomesBySha256 = {} } = {}) {
  const allowed = new Set(['clean', 'unsafe', 'unavailable']);
  if (!allowed.has(defaultOutcome)) throw new Error('Fake scanner default outcome is invalid.');
  return {
    name: 'deterministic-fake',
    version: '1',
    async scan({ sha256 }) {
      const outcome = outcomesBySha256[sha256] || defaultOutcome;
      if (!allowed.has(outcome)) throw new Error('Fake scanner configured an invalid outcome.');
      return { outcome };
    },
  };
}

export async function scanCimAttachment({ intakeId, storage, quarantineRoot, scanner, now = new Date() } = {}) {
  const intake = await storage.getCimAttachmentIntake(boundedIdentifier(intakeId, 'Attachment intake id'));
  if (!intake) throw new Error('Attachment intake was not found.');
  if (intake.lifecycle_status === 'published' || intake.scan_status === 'clean' || intake.scan_status === 'unsafe') return intake;
  if (!['scan-pending', 'scan-unavailable'].includes(intake.lifecycle_status)) {
    throw new Error('Attachment is not eligible for scanning.');
  }
  if (intake.lifecycle_status === 'scan-unavailable' && Number(intake.scan_attempt_count || 0) >= maximumScanAttempts) {
    return intake;
  }
  const scanTime = isoNow(now);
  if (intake.lifecycle_status === 'scan-unavailable' && intake.next_scan_at
    && Date.parse(scanTime) < Date.parse(intake.next_scan_at)) {
    throw new Error(`Attachment scan retry is not due until ${intake.next_scan_at}.`);
  }
  if (!scanner || typeof scanner.scan !== 'function' || !scanner.name || !scanner.version) {
    throw new Error('An explicit scanner adapter is required.');
  }
  const { candidate: filePath } = await assertOwnedRegularFile(quarantineRoot, intake.quarantine_path);
  const identity = await hashOwnedFile(quarantineRoot, intake.quarantine_path);
  if (identity.sha256 !== intake.sha256 || identity.size !== Number(intake.size_bytes)) {
    throw new Error('Quarantined attachment failed integrity validation.');
  }
  const result = await scanner.scan({ filePath, sha256: intake.sha256, sizeBytes: identity.size, mimeType: intake.detected_mime_type });
  const outcome = result?.outcome;
  if (!['clean', 'unsafe', 'unavailable'].includes(outcome)) throw new Error('Scanner returned an invalid outcome.');
  const updatedAt = scanTime;
  const attemptCount = Number(intake.scan_attempt_count || 0) + 1;
  const values = {
    updated_at: updatedAt,
    lifecycle_status: outcome === 'clean' ? 'awaiting-owner-approval' : outcome === 'unsafe' ? 'unsafe' : 'scan-unavailable',
    scan_status: outcome,
    scan_attempt_count: attemptCount,
    scanner_name: String(scanner.name).slice(0, 120),
    scanner_version: String(scanner.version).slice(0, 120),
    scan_last_error: outcome === 'unavailable' ? String(result.error || 'scanner unavailable').slice(0, 500) : null,
    hold_reason: outcome === 'unsafe'
      ? 'unsafe'
      : outcome === 'unavailable'
        ? (attemptCount >= maximumScanAttempts ? 'retry_exhausted' : 'scan_unavailable')
        : null,
    next_scan_at: outcome === 'unavailable' && attemptCount < maximumScanAttempts
      ? new Date(Date.parse(updatedAt) + retryDelaysMs[attemptCount - 1]).toISOString()
      : null,
  };
  const updated = await storage.updateCimAttachmentIntake(intake.id, values, { expectedStatus: intake.lifecycle_status });
  if (!updated) return storage.getCimAttachmentIntake(intake.id);
  return updated;
}

function assertFrozenApproval(intake, { submissionId, documentType, actor }) {
  if (intake.approved_submission_id && intake.approved_submission_id !== submissionId) {
    throw new Error('Attachment publication intent is frozen for another business.');
  }
  if (intake.approved_document_type && intake.approved_document_type !== documentType) {
    throw new Error('Attachment publication intent is frozen for another document type.');
  }
  if (intake.owner_approved_by && intake.owner_approved_by !== actor) {
    throw new Error('Attachment publication intent is frozen for another owner actor.');
  }
}

async function ensureVaultFile({ intake, quarantineRoot, vaultRoot, relativePath, copyFile = fs.copyFile }) {
  const { candidate: sourcePath } = await assertOwnedRegularFile(quarantineRoot, intake.quarantine_path);
  const destinationPath = ownedPath(vaultRoot, relativePath);
  await ensureOwnedDirectory(vaultRoot, path.dirname(relativePath));
  const sourceIdentity = await hashOwnedFile(quarantineRoot, intake.quarantine_path);
  if (sourceIdentity.sha256 !== intake.sha256 || sourceIdentity.size !== Number(intake.size_bytes)) {
    throw new Error('Quarantined attachment failed integrity validation.');
  }
  try {
    const destinationIdentity = await hashOwnedFile(vaultRoot, relativePath);
    if (destinationIdentity.sha256 !== intake.sha256 || destinationIdentity.size !== Number(intake.size_bytes)) {
      throw new Error('Existing vault publication file failed integrity validation.');
    }
    return destinationPath;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporaryPath = `${destinationPath}.partial-${randomUUID()}`;
  try {
    await copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
    await fs.chmod(temporaryPath, 0o600);
    const handle = await fs.open(temporaryPath, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporaryPath, destinationPath);
    await fs.chmod(destinationPath, 0o600);
    return destinationPath;
  } catch (error) {
    await safeUnlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function publishApprovedCimAttachment({
  intakeId,
  submissionId,
  documentType,
  actor,
  storage,
  quarantineRoot,
  vaultRoot,
  copyFile,
  now = new Date(),
} = {}) {
  const normalizedSubmissionId = boundedIdentifier(submissionId, 'Submission id');
  const normalizedActor = boundedIdentifier(actor, 'Owner actor');
  const requestedType = String(documentType || '').trim().toLowerCase();
  const canonicalRequestedType = requestedType.replace(/-/g, '_');
  if (!requestedType || (!allowedDocumentTypes.has(canonicalRequestedType)
    && !allowedDocumentTypeAliases.has(requestedType))) {
    throw new Error('An explicit recognized document type is required.');
  }
  const normalizedType = normalizeSecureDocumentType(documentType);
  if (!allowedDocumentTypes.has(normalizedType)) throw new Error('Document type is not allowed.');
  let intake = await storage.getCimAttachmentIntake(boundedIdentifier(intakeId, 'Attachment intake id'));
  if (!intake) throw new Error('Attachment intake was not found.');
  assertFrozenApproval(intake, { submissionId: normalizedSubmissionId, documentType: normalizedType, actor: normalizedActor });
  if (intake.lifecycle_status === 'published') return intake;
  if (intake.scan_status !== 'clean' || !['awaiting-owner-approval', 'publishing'].includes(intake.lifecycle_status)) {
    throw new Error('Attachment publication requires a clean scan and owner approval.');
  }

  const communication = await storage.getCrmCommunication(intake.communication_id);
  if (!communication || communication.direction !== 'inbound') throw new Error('Attachment inbound communication was not found.');
  if (!communication.submission_id) {
    await storage.updateCimAttachmentIntake(intake.id, {
      hold_reason: 'assignment_ambiguous', updated_at: isoNow(now),
    }, { expectedStatus: intake.lifecycle_status });
    throw new Error('Attachment communication must be assigned before publication.');
  }
  if (communication.submission_id !== normalizedSubmissionId) {
    await storage.updateCimAttachmentIntake(intake.id, {
      hold_reason: 'wrong_business', updated_at: isoNow(now),
    }, { expectedStatus: intake.lifecycle_status });
    throw new Error('Attachment communication is assigned to another business.');
  }
  const submission = await storage.getSubmission(normalizedSubmissionId);
  if (!submission) throw new Error('Approved business was not found.');

  const approvedAt = isoNow(now);
  if (intake.lifecycle_status === 'awaiting-owner-approval') {
    const requestId = randomUUID();
    const documentId = randomUUID();
    const relativePath = path.join(requestId, `${documentId}-${sanitizeSecureDocumentFileName(intake.original_file_name)}`);
    const claimed = await storage.updateCimAttachmentIntake(intake.id, {
      lifecycle_status: 'publishing',
      owner_approved_at: approvedAt,
      owner_approved_by: normalizedActor,
      approved_submission_id: normalizedSubmissionId,
      approved_document_type: normalizedType,
      vault_request_id: requestId,
      vault_document_id: documentId,
      vault_relative_path: relativePath,
      hold_reason: null,
      updated_at: approvedAt,
    }, { expectedStatus: 'awaiting-owner-approval' });
    intake = claimed || await storage.getCimAttachmentIntake(intake.id);
    assertFrozenApproval(intake, { submissionId: normalizedSubmissionId, documentType: normalizedType, actor: normalizedActor });
    if (intake.lifecycle_status === 'published') return intake;
  }

  const storagePath = await ensureVaultFile({
    intake,
    quarantineRoot,
    vaultRoot,
    relativePath: intake.vault_relative_path,
    copyFile,
  });
  const request = {
    id: intake.vault_request_id,
    submission_id: normalizedSubmissionId,
    created_at: intake.owner_approved_at,
    updated_at: approvedAt,
    email: submission.email || '',
    contact_name: submission.name || '',
    requested_by: normalizedActor,
    status: 'documents-received',
    expires_at: approvedAt,
    nda_required: false,
    nda_accepted_at: null,
    last_uploaded_at: approvedAt,
    note: 'Owner-approved inbound CIM attachment publication.',
    requested_documents: [{ category: normalizedType, label: normalizedType, required: true }],
    revoked_at: null,
    closed_at: approvedAt,
    upload_batch_count: 1,
  };
  const document = {
    id: intake.vault_document_id,
    request_id: intake.vault_request_id,
    submission_id: normalizedSubmissionId,
    created_at: approvedAt,
    document_type: normalizedType,
    file_name: path.basename(storagePath),
    original_name: intake.original_file_name,
    mime_type: intake.detected_mime_type,
    size_bytes: Number(intake.size_bytes),
    storage_path: storagePath,
    uploaded_by_email: normalizedActor,
    note: 'Published from clean scanned inbound quarantine.',
    nda_accepted_at: null,
  };
  try {
    const published = await storage.publishCimAttachmentToVault({
      intakeId: intake.id,
      expectedStatus: 'publishing',
      request,
      document,
      publishedAt: approvedAt,
    });
    return published || storage.getCimAttachmentIntake(intake.id);
  } catch (error) {
    if (/assignment|supersed/i.test(String(error?.message || ''))) {
      await storage.updateCimAttachmentIntake(intake.id, {
        hold_reason: 'assignment_ambiguous', updated_at: approvedAt,
      }, { expectedStatus: 'publishing' }).catch(() => {});
    }
    throw error;
  }
}

export async function cleanupStaleCimAttachmentPartials({
  quarantineRoot,
  storage,
  now = new Date(),
  staleAfterMs = 24 * 60 * 60 * 1000,
} = {}) {
  if (!storage || typeof storage.getCimAttachmentIntake !== 'function') {
    throw new Error('Attachment partial cleanup requires lifecycle storage authority.');
  }
  const current = Date.parse(isoNow(now));
  const removed = [];
  const recovered = [];
  let entries;
  try {
    await ensureOwnedRoot(quarantineRoot);
    if (storage.listCimAttachmentIntakes) {
      const intakes = await storage.listCimAttachmentIntakes({ limit: 10000 });
      for (const intake of intakes.filter((row) => row.lifecycle_status === 'quarantining')) {
        await recoverCimAttachmentIntake({ intake, storage, quarantineRoot, now });
        recovered.push(intake.id);
      }
    }
    entries = await fs.readdir(quarantineRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { removed, recovered };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('.partial-')) continue;
    const intakeId = entry.name.slice('.partial-'.length);
    const intake = intakeId ? await storage.getCimAttachmentIntake(intakeId) : null;
    if (intake) {
      if (intake.lifecycle_status === 'quarantining') {
        await recoverCimAttachmentIntake({ intake, storage, quarantineRoot, now });
        if (!recovered.includes(intake.id)) recovered.push(intake.id);
      }
      continue;
    }
    const filePath = ownedPath(quarantineRoot, entry.name);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || current - stat.mtimeMs <= staleAfterMs) continue;
    await fs.unlink(filePath);
    removed.push(entry.name);
  }
  return { removed: removed.sort(), recovered: recovered.sort() };
}
