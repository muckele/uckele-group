import { assertQualificationHardOff } from './p10bQualificationContract.js';
import { captureQualificationSignatureReceipt } from './p10bQualificationLifecycle.js';
import { stableCanonicalJson } from '../utils/security.js';
import fs from 'node:fs';
import { sha256 } from '../utils/security.js';
import { parseP10bGuestWindow } from './p10bGuestShutdown.js';

export const P10B_MACHINE_ID = '0803730bd1d7e8';

export function p10bDatabaseIdentity(databasePath, fileSystem = fs) {
  const realPath = fileSystem.realpathSync(databasePath);
  const stat = fileSystem.statSync(realPath);
  if (!stat.isFile() || fileSystem.lstatSync(databasePath).isSymbolicLink()) throw new Error('Invalid qualification database');
  return sha256(stableCanonicalJson({ version: 'p10b-sqlite-database-identity-v1',
    realPath, device: String(stat.dev), inode: String(stat.ino) }));
}

export function initializeP10bRuntimeFilesystem(config, { environment = process.env,
  sourceHead, clock = () => new Date(), fileSystem = fs } = {}) {
  if (!isP10bQualificationRuntime(config)) return;
  sourceHead ||= fs.readFileSync('/app/p10b-source-head.txt', 'utf8').trim();
  assertQualificationHardOff(config);
  const databasePath = config.storage.sqlitePath;
  const phase = config.dealHunter.cimProvider.qualificationPhase;
  const guestWindowDigest = config.dealHunter.cimProvider.qualificationGuestWindow
    ? sha256(stableCanonicalJson(parseP10bGuestWindow(config.dealHunter.cimProvider.qualificationGuestWindow))) : null;
  if (config.storage.provider !== 'sqlite' || !['prepare', 'qualify'].includes(phase) || environment.FLY_APP_NAME !== 'uckele-group-p10b'
    || environment.FLY_MACHINE_ID !== P10B_MACHINE_ID || !/^[0-9a-f]{40}$/.test(sourceHead)
    || !/^\/data\/p10b-first-mailbox-[a-z0-9-]{1,80}\.sqlite$/.test(databasePath)) {
    throw new Error('Explicit isolated qualification startup binding required');
  }
  const markerPath = `${databasePath}.p10b-start.json`;
  if (phase === 'prepare') {
    if ([databasePath, `${databasePath}-wal`, `${databasePath}-shm`, markerPath,
      `${databasePath}.p10b-preparation.json`, `${databasePath}.p10b-qualify-start.json`,
      `${databasePath}.p10b-qualify-worker.json`].some((file) => fileSystem.existsSync(file))) {
      throw new Error('Qualification preparation path is retained; no retry');
    }
    fileSystem.writeFileSync(markerPath, JSON.stringify({ version: 'p10b-fresh-start-v1', sourceHead,
      app: environment.FLY_APP_NAME, machineId: environment.FLY_MACHINE_ID,
      guestWindowDigest, startedAt: new Date(clock()).toISOString() }), { flag: 'wx', mode: 0o600 });
  } else {
    const preparation = JSON.parse(fileSystem.readFileSync(`${databasePath}.p10b-preparation.json`, 'utf8'));
    if (preparation.sourceHead !== sourceHead || preparation.app !== environment.FLY_APP_NAME
      || preparation.machineId !== environment.FLY_MACHINE_ID
      || preparation.databaseIdentityHash !== p10bDatabaseIdentity(databasePath, fileSystem)) {
      throw new Error('Retained qualification database binding changed');
    }
    fileSystem.writeFileSync(`${databasePath}.p10b-qualify-start.json`, JSON.stringify({
      version: 'p10b-one-start-v1', sourceHead, databaseIdentityHash: preparation.databaseIdentityHash,
      guestWindowDigest,
      startedAt: new Date(clock()).toISOString() }), { flag: 'wx', mode: 0o600 });
  }
}

export function isP10bQualificationRuntime(config) {
  return config?.dealHunter?.cimProvider?.qualificationRuntime === true;
}

export function p10bIngressOnly(config) {
  return (request, response, next) => {
    if (!isP10bQualificationRuntime(config)) return next();
    assertQualificationHardOff(config);
    if ((['GET', 'HEAD'].includes(request.method) && request.path === '/api/health')
      || (config.dealHunter.cimProvider.qualificationPhase === 'qualify'
        && request.method === 'POST' && request.path === '/api/webhooks/resend')) return next();
    response.status(404).json({ success: false, error: 'Route unavailable in isolated qualification.' });
  };
}

export function p10bPublicConfigurationDigest(config) {
  assertQualificationHardOff(config);
  const p = config.dealHunter.cimProvider;
  return sha256(stableCanonicalJson({ version: 'p10b-public-runtime-configuration-v1',
    isProduction: config.isProduction, qualificationRuntime: p.qualificationRuntime,
    qualificationPhase: p.qualificationPhase, providerProfile: p.profile,
    guestWindowDigest: p.qualificationGuestWindow ? sha256(stableCanonicalJson(parseP10bGuestWindow(p.qualificationGuestWindow))) : null,
    from: p.resendFromEmail, replyBase: p.resendReplyTo, domain: p.resendInboundDomain,
    allowedRecipients: p.allowedRecipients, databasePath: config.storage.sqlitePath,
    sendingCredentialPresent: Boolean(p.resendApiKey), readCredentialPresent: Boolean(p.reconciliationApiKey),
    webhookCredentialPresent: Boolean(p.emailWebhookSecret), hardOffVerified: true }));
}

export function qualificationInboundCommand(event, config, now) {
  assertQualificationHardOff(config);
  const receipt = event?.metadata?.qualificationSignatureReceipt;
  if (!receipt || event.provider !== 'resend' || event.source !== 'webhook'
    || event.provider_event_id !== receipt.svixId) return null;
  const verified = captureQualificationSignatureReceipt({ rawBody: receipt.rawBody,
    headers: { 'svix-id': receipt.svixId, 'svix-timestamp': receipt.svixTimestamp,
      'svix-signature': receipt.svixSignature } }, config, now);
  if (!verified) return null;
  const payload = JSON.parse(verified.rawBody);
  const data = payload.data;
  if (event.message_id !== data.email_id || !Array.isArray(data.to)
    || stableCanonicalJson(event.metadata.to) !== stableCanonicalJson(data.to)
    || event.metadata.from !== data.from) return null;
  const mailbox = String(data.from).match(/^(?:[^<>\r\n,;]+\s*)?<([^<>\s,;]+@[^<>\s,;]+)>$/)?.[1]
    || String(data.from).match(/^[^<>\s,;]+@[^<>\s,;]+$/)?.[0];
  return { type: payload.type, from: payload.type === 'email.received' ? mailbox?.toLowerCase() : data.from,
    to: data.to, providerMessageId: data.email_id, providerEventId: verified.svixId, now };
}

// The existing listener is reused. The isolated runtime runs no background
// jobs or startup deletion, including ingestion retries. Ordinary startup is
// unchanged and cannot acquire this mode accidentally through NODE_ENV.
export async function runServerStartupMaintenance(config, tasks) {
  if (isP10bQualificationRuntime(config)) {
    assertQualificationHardOff(config);
    return { reviewed: 0, isolated: true };
  }
  await tasks.cleanupAuth();
  return tasks.cleanupDocuments();
}

export function startServerSchedulers(config, factories) {
  if (isP10bQualificationRuntime(config)) {
    assertQualificationHardOff(config);
    return [];
  }
  return factories.map((start) => start());
}
