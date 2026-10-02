#!/usr/bin/env node

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../server/config.js';
import {
  P10B_EXECUTION_CONFIRMATION,
  P10B_LIMITED_SMOKE_CONFIRMATION,
  buildP10bLimitedSmokePostRunAttestation,
  executeP10bControlledMailbox,
  executeP10bLimitedFreeSmoke,
  prepareP10bControlledMailbox,
  prepareP10bLimitedFreeSmoke,
} from '../server/services/pursueCimControlledMailboxHarness.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';

const usage = `Usage:
  npm run cim:p10b -- prepare --sqlite-path <isolated-p10b.sqlite> --output <review.json> \\
    --run-id <id> --recipient <address> --permission-evidence-id <id> \\
    --permission-evidence-hash <sha256> [--recipient-name <name>] [--actor <name>]

  npm run cim:p10b -- execute --sqlite-path <isolated-p10b.sqlite> --review <review.json> \\
    --readiness <readiness.json> --evidence-output <evidence.json> --expires-at <iso> \\
    --confirmation "${P10B_EXECUTION_CONFIRMATION}" [--actor <name>]

  npm run cim:p10b -- prepare-limited --sqlite-path <fresh-isolated-p10b.sqlite> \\
    --output <review.json> --run-id <id> --recipient mathew@uckelegroup.com \\
    --permission-evidence-id <id> --permission-evidence-hash <sha256> [--actor <name>]

  npm run cim:p10b -- execute-limited --sqlite-path <isolated-p10b.sqlite> \\
    --review <review.json> --readiness <readiness.json> --evidence-output <evidence.json> \\
    --expires-at <iso> \\
    --confirmation "${P10B_LIMITED_SMOKE_CONFIRMATION}" [--actor <name>]

  npm run cim:p10b -- attest-limited --review <review.json> --evidence <evidence.json> \\
    --attestation-output <attestation.json> --observed-at <iso> \\
    --key-permission sending-access --key-domain-scope p10b.uckelegroup.com \\
    --key-revoked-at <iso> --secret-removed-at <iso> \\
    --manual-receipt <observed|not-observed> [--manual-receipt-observed-at <iso>] \\
    [--actor <name>]

Prepare is provider-inert and refuses an existing database or output file. Execute rereads the
durable transmission, requires the exact review digest, and writes only redacted evidence.
Limited prepare is provider-inert and keyless. Limited execution remains partial P10B evidence;
attestation records manual cleanup observations separately and never upgrades lifecycle trust.
`;

function argumentsMap(argv) {
  const [mode = '', ...values] = argv;
  const args = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`);
    const name = item.slice(2);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    if (Object.hasOwn(args, name)) throw new Error(`Duplicate argument: --${name}`);
    args[name] = value;
    index += 1;
  }
  return { mode, args };
}

function required(args, name) {
  const value = String(args[name] || '').trim();
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function isolatedSqlitePath(value, { mustExist }) {
  const resolved = path.resolve(value);
  if (!/p10b/i.test(path.basename(resolved)) || path.extname(resolved) !== '.sqlite') {
    throw new Error('The isolated SQLite filename must contain "p10b" and end in .sqlite');
  }
  const exists = fs.existsSync(resolved);
  if (mustExist && !exists) throw new Error('The prepared P10B SQLite database does not exist');
  if (!mustExist && exists) throw new Error('Prepare refuses to reuse an existing P10B SQLite database');
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return resolved;
}

function readJson(file, label) {
  const resolved = path.resolve(file);
  const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  return value;
}

function databaseIdentityHash(sqlitePath) {
  const realPath = fs.realpathSync(path.resolve(sqlitePath));
  const stat = fs.statSync(realPath);
  return sha256(stableCanonicalJson({ version: 'p10b-sqlite-database-identity-v1',
    realPath, device: String(stat.dev), inode: String(stat.ino) }));
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readCleanImplementationHead(root = repositoryRoot) {
  let head;
  let status;
  try {
    head = execFileSync('git', ['-C', path.resolve(root), 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().toLowerCase();
    status = execFileSync('git', ['-C', path.resolve(root), 'status', '--porcelain=v1',
      '--untracked-files=all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('P10B limited smoke requires a readable clean Git checkout');
  }
  if (!/^[0-9a-f]{40}$/.test(head) || status) {
    throw new Error('P10B limited smoke requires the exact clean checkout head');
  }
  return head;
}

function reserveOutput(file, forbiddenPaths = []) {
  const resolved = path.resolve(file);
  if (forbiddenPaths.map((item) => path.resolve(item)).includes(resolved)) {
    throw new Error('P10B output must not overwrite an input or database file');
  }
  if (fs.existsSync(resolved)) throw new Error('P10B refuses to overwrite an existing output file');
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return { path: resolved, descriptor: fs.openSync(resolved, 'wx', 0o600), closed: false };
}

function writeReservedJson(reservation, value) {
  try {
    fs.writeFileSync(reservation.descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(reservation.descriptor);
  } finally {
    fs.closeSync(reservation.descriptor);
    reservation.closed = true;
  }
  return reservation.path;
}

function discardReservation(reservation) {
  if (!reservation.closed) {
    fs.closeSync(reservation.descriptor);
    reservation.closed = true;
  }
  try { fs.unlinkSync(reservation.path); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function prepare(args, config) {
  const sqlitePath = isolatedSqlitePath(required(args, 'sqlite-path'), { mustExist: false });
  const output = reserveOutput(required(args, 'output'), [sqlitePath]);
  let storage;
  let written = false;
  try {
    storage = createSqliteStorage({ storage: { sqlitePath },
      protection: { rateLimitRetentionMs: config.protection?.rateLimitRetentionMs || 0 } });
    const result = await prepareP10bControlledMailbox({ storage, config,
      actor: args.actor || 'p10b-release-owner', now: new Date().toISOString(),
      synthetic: { runId: required(args, 'run-id'), recipient: required(args, 'recipient'),
        recipientDisplayName: args['recipient-name'] || 'Controlled Mailbox Owner',
        permissionEvidenceId: required(args, 'permission-evidence-id'),
        permissionEvidenceHash: required(args, 'permission-evidence-hash') } });
    writeReservedJson(output, result);
    written = true;
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'prepare', output: output.path,
      opportunityId: result.opportunityId, reviewDigest: result.review.digest })}\n`);
  } finally {
    storage?.close();
    if (!written) discardReservation(output);
  }
}

async function prepareLimited(args, config) {
  const sqlitePath = isolatedSqlitePath(required(args, 'sqlite-path'), { mustExist: false });
  const output = reserveOutput(required(args, 'output'), [sqlitePath]);
  let storage;
  let written = false;
  try {
    storage = createSqliteStorage({ storage: { sqlitePath },
      protection: { rateLimitRetentionMs: config.protection?.rateLimitRetentionMs || 0 } });
    const result = await prepareP10bLimitedFreeSmoke({ storage, config,
      actor: args.actor || 'p10b-release-owner', now: new Date().toISOString(),
      databaseIdentityHash: databaseIdentityHash(sqlitePath),
      implementationHead: readCleanImplementationHead(),
      synthetic: { runId: required(args, 'run-id'), recipient: required(args, 'recipient'),
        recipientDisplayName: args['recipient-name'] || 'Controlled Mailbox Owner',
        permissionEvidenceId: required(args, 'permission-evidence-id'),
        permissionEvidenceHash: required(args, 'permission-evidence-hash') } });
    writeReservedJson(output, result);
    written = true;
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'prepare-limited',
      output: output.path, opportunityId: result.opportunityId,
      reviewDigest: result.review.digest })}\n`);
  } finally {
    storage?.close();
    if (!written) discardReservation(output);
  }
}

async function execute(args, config) {
  const sqlitePath = isolatedSqlitePath(required(args, 'sqlite-path'), { mustExist: true });
  const preparation = readJson(required(args, 'review'), 'P10B review');
  const readiness = readJson(required(args, 'readiness'), 'P10B readiness');
  const reviewPath = path.resolve(required(args, 'review'));
  const readinessPath = path.resolve(required(args, 'readiness'));
  const evidenceOutput = reserveOutput(required(args, 'evidence-output'),
    [sqlitePath, reviewPath, readinessPath]);
  let storage;
  let written = false;
  try {
    storage = createSqliteStorage({ storage: { sqlitePath },
      protection: { rateLimitRetentionMs: config.protection?.rateLimitRetentionMs || 0 } });
    let result;
    try {
      result = await executeP10bControlledMailbox({ storage, config,
        opportunityId: preparation.opportunityId,
        initialActivationId: preparation.initialActivationId,
        reviewDigest: preparation.review?.digest,
        confirmation: required(args, 'confirmation'), expiresAt: required(args, 'expires-at'),
        actor: args.actor || 'p10b-release-owner', now: new Date().toISOString(),
        providerReadiness: readiness });
    } catch (error) {
      if (error?.p10bEvidence) {
        writeReservedJson(evidenceOutput, error.p10bEvidence);
        written = true;
      }
      const safe = new Error(`P10B execution failed (${error?.code || 'P10B_EXECUTION_FAILED'}); inspect redacted evidence`);
      safe.code = error?.code || 'P10B_EXECUTION_FAILED';
      safe.cause = error;
      throw safe;
    }
    const output = writeReservedJson(evidenceOutput, result.evidence);
    written = true;
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'execute', output,
      outcome: result.evidence.outcome, providerCalls: result.evidence.providerCalls })}\n`);
  } finally {
    storage?.close();
    if (!written) discardReservation(evidenceOutput);
  }
}

async function executeLimited(args, config) {
  const sqlitePath = isolatedSqlitePath(required(args, 'sqlite-path'), { mustExist: true });
  const preparation = readJson(required(args, 'review'), 'P10B limited review');
  const readiness = readJson(required(args, 'readiness'), 'P10B limited readiness');
  const reviewPath = path.resolve(required(args, 'review'));
  const readinessPath = path.resolve(required(args, 'readiness'));
  const evidenceOutput = reserveOutput(required(args, 'evidence-output'),
    [sqlitePath, reviewPath, readinessPath]);
  let storage;
  let written = false;
  try {
    storage = createSqliteStorage({ storage: { sqlitePath },
      protection: { rateLimitRetentionMs: config.protection?.rateLimitRetentionMs || 0 } });
    let result;
    try {
      result = await executeP10bLimitedFreeSmoke({ storage, config,
        opportunityId: preparation.opportunityId,
        initialActivationId: preparation.initialActivationId,
        reviewDigest: preparation.review?.digest,
        confirmation: required(args, 'confirmation'), expiresAt: required(args, 'expires-at'),
        actor: args.actor || 'p10b-release-owner', now: new Date().toISOString(),
        providerReadiness: readiness, databaseIdentityHash: databaseIdentityHash(sqlitePath),
        implementationHead: readCleanImplementationHead() });
    } catch (error) {
      if (error?.p10bEvidence) {
        writeReservedJson(evidenceOutput, error.p10bEvidence);
        written = true;
      }
      const safe = new Error(`P10B limited execution failed (${error?.code
        || 'P10B_LIMITED_EXECUTION_FAILED'}); inspect redacted evidence`);
      safe.code = error?.code || 'P10B_LIMITED_EXECUTION_FAILED';
      safe.cause = error;
      throw safe;
    }
    const output = writeReservedJson(evidenceOutput, result.evidence);
    written = true;
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'execute-limited', output,
      outcome: result.evidence.outcome, providerCalls: result.evidence.providerCalls,
      p10bComplete: false })}\n`);
  } finally {
    storage?.close();
    if (!written) discardReservation(evidenceOutput);
  }
}

function attestLimited(args) {
  const reviewPath = path.resolve(required(args, 'review'));
  const evidencePath = path.resolve(required(args, 'evidence'));
  const preparation = readJson(reviewPath, 'P10B limited review');
  const runEvidenceRaw = fs.readFileSync(evidencePath, 'utf8');
  const output = reserveOutput(required(args, 'attestation-output'),
    [reviewPath, evidencePath]);
  let written = false;
  try {
    const receipt = required(args, 'manual-receipt');
    if (!['observed', 'not-observed'].includes(receipt)) {
      throw new Error('P10B limited manual receipt must be observed or not-observed');
    }
    const attestation = buildP10bLimitedSmokePostRunAttestation({ runEvidenceRaw,
      review: preparation, actor: args.actor || 'p10b-release-owner',
      observedAt: required(args, 'observed-at'),
      keyPermission: required(args, 'key-permission'),
      keyDomainScope: required(args, 'key-domain-scope'),
      keyRevokedAt: required(args, 'key-revoked-at'),
      secretRemovedAt: required(args, 'secret-removed-at'),
      manualReceiptObserved: receipt === 'observed',
      manualReceiptObservedAt: args['manual-receipt-observed-at'] || '' });
    const outputPath = writeReservedJson(output, attestation);
    written = true;
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'attest-limited',
      output: outputPath, runEvidenceDigest: attestation.runEvidenceDigest,
      trustedLifecycleEvidence: false })}\n`);
  } finally {
    if (!written) discardReservation(output);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage);
    return;
  }
  const { mode, args } = argumentsMap(argv);
  const config = getConfig();
  if (mode === 'prepare') await prepare(args, config);
  else if (mode === 'execute') await execute(args, config);
  else if (mode === 'prepare-limited') await prepareLimited(args, config);
  else if (mode === 'execute-limited') await executeLimited(args, config);
  else if (mode === 'attest-limited') attestLimited(args);
  else throw new Error('P10B mode must be prepare, execute, prepare-limited, execute-limited, or attest-limited');
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[p10b-controlled-mailbox] ${error.message}\n`);
    process.exitCode = 1;
  });
}
