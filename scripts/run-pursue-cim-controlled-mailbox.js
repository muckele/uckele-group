#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../server/config.js';
import {
  P10B_EXECUTION_CONFIRMATION,
  executeP10bControlledMailbox,
  prepareP10bControlledMailbox,
} from '../server/services/pursueCimControlledMailboxHarness.js';
import { createSqliteStorage } from '../server/storage/sqlite.js';

const usage = `Usage:
  npm run cim:p10b -- prepare --sqlite-path <isolated-p10b.sqlite> --output <review.json> \\
    --run-id <id> --recipient <address> --permission-evidence-id <id> \\
    --permission-evidence-hash <sha256> [--recipient-name <name>] [--actor <name>]

  npm run cim:p10b -- execute --sqlite-path <isolated-p10b.sqlite> --review <review.json> \\
    --readiness <readiness.json> --evidence-output <evidence.json> --expires-at <iso> \\
    --confirmation "${P10B_EXECUTION_CONFIRMATION}" [--actor <name>]

Prepare is provider-inert and refuses an existing database or output file. Execute rereads the
durable transmission, requires the exact review digest, and writes only redacted evidence.
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

function newOutputPath(file, forbiddenPaths = []) {
  const resolved = path.resolve(file);
  if (forbiddenPaths.map((item) => path.resolve(item)).includes(resolved)) {
    throw new Error('P10B output must not overwrite an input or database file');
  }
  if (fs.existsSync(resolved)) throw new Error('P10B refuses to overwrite an existing output file');
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return resolved;
}

function writeNewJson(file, value) {
  const resolved = path.resolve(file);
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  return resolved;
}

async function prepare(args, config) {
  const sqlitePath = isolatedSqlitePath(required(args, 'sqlite-path'), { mustExist: false });
  const output = newOutputPath(required(args, 'output'), [sqlitePath]);
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: config.protection?.rateLimitRetentionMs || 0 } });
  try {
    const result = await prepareP10bControlledMailbox({ storage, config,
      actor: args.actor || 'p10b-release-owner', now: new Date().toISOString(),
      synthetic: { runId: required(args, 'run-id'), recipient: required(args, 'recipient'),
        recipientDisplayName: args['recipient-name'] || 'Controlled Mailbox Owner',
        permissionEvidenceId: required(args, 'permission-evidence-id'),
        permissionEvidenceHash: required(args, 'permission-evidence-hash') } });
    writeNewJson(output, result);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'prepare', output,
      opportunityId: result.opportunityId, reviewDigest: result.review.digest })}\n`);
  } finally {
    storage.close();
  }
}

async function execute(args, config) {
  const sqlitePath = isolatedSqlitePath(required(args, 'sqlite-path'), { mustExist: true });
  const preparation = readJson(required(args, 'review'), 'P10B review');
  const readiness = readJson(required(args, 'readiness'), 'P10B readiness');
  const reviewPath = path.resolve(required(args, 'review'));
  const readinessPath = path.resolve(required(args, 'readiness'));
  const evidenceOutput = newOutputPath(required(args, 'evidence-output'),
    [sqlitePath, reviewPath, readinessPath]);
  const storage = createSqliteStorage({ storage: { sqlitePath },
    protection: { rateLimitRetentionMs: config.protection?.rateLimitRetentionMs || 0 } });
  try {
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
      if (error?.p10bEvidence) writeNewJson(evidenceOutput, error.p10bEvidence);
      const safe = new Error(`P10B execution failed (${error?.code || 'P10B_EXECUTION_FAILED'}); inspect redacted evidence`);
      safe.code = error?.code || 'P10B_EXECUTION_FAILED';
      safe.cause = error;
      throw safe;
    }
    const output = writeNewJson(evidenceOutput, result.evidence);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'execute', output,
      outcome: result.evidence.outcome, providerCalls: result.evidence.providerCalls })}\n`);
  } finally {
    storage.close();
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
  else throw new Error('P10B mode must be prepare or execute');
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[p10b-controlled-mailbox] ${error.message}\n`);
    process.exitCode = 1;
  });
}
