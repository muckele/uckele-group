import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getConfig } from '../config.js';
import { createSqliteStorage } from '../storage/sqlite.js';
import { prepareP10bControlledMailbox, executeP10bFirstMailboxQualification } from './pursueCimControlledMailboxHarness.js';
import { assertQualificationHardOff, qualificationDigest } from './p10bQualificationContract.js';
import { validateP10bRuntimePacket } from './p10bQualificationHost.js';
import { isP10bQualificationRuntime, p10bDatabaseIdentity, p10bPublicConfigurationDigest, P10B_MACHINE_ID } from './p10bRuntime.js';
import { requestP10bIngressClosure } from './p10bIngressClosure.js';
import { assertP10bGuestReady, completeP10bGuestHandoff, parseP10bGuestWindow, p10bGuestWindow,
  requestP10bGuestShutdown, writeP10bGuestRecord } from './p10bGuestShutdown.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { p10bRuntimeFailure } from './p10bRuntimeFailure.js';

function metadata(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const count = (table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    return { databaseIdentityHash: p10bDatabaseIdentity(databasePath),
      transmissions: count('deal_hunter_cim_transmissions'),
      authorizations: count('deal_hunter_cim_live_provider_authorizations'),
      opportunities: count('deal_hunter_opportunities'), submissions: count('contact_submissions') };
  } finally { database.close(); }
}

function assertRuntime(config, packet, runtime) {
  assertQualificationHardOff(config);
  if (!isP10bQualificationRuntime(config) || config.dealHunter.cimProvider.qualificationPhase !== packet.operation
    || config.storage.provider !== 'sqlite' || config.storage.sqlitePath !== packet.databasePath
    || !/^\/data\/p10b-first-mailbox-[a-z0-9-]{1,80}\.sqlite$/.test(packet.databasePath)
    || runtime.app !== 'uckele-group-p10b' || runtime.app !== packet.target.app
    || runtime.machineId !== P10B_MACHINE_ID || runtime.machineId !== packet.target.machineId
    || runtime.sourceHead !== packet.sourceHead) {
    throw new Error('Worker runtime binding failed');
  }
  if (stableCanonicalJson(parseP10bGuestWindow(config.dealHunter.cimProvider.qualificationGuestWindow, runtime))
    !== stableCanonicalJson(p10bGuestWindow(packet))) throw new Error('Guest cutoff binding changed');
}

// Dependency injection is for offline boundary tests; the shipped CLI uses
// genuine environment/filesystem/SQLite observations and the existing API.
export async function serveP10bQualificationWorker({ channel, config = getConfig(),
  runtime = { app: process.env.FLY_APP_NAME, machineId: process.env.FLY_MACHINE_ID,
    sourceHead: fs.readFileSync('/app/p10b-source-head.txt', 'utf8').trim() },
  validateRuntime = assertRuntime, createStorage = createSqliteStorage,
  prepare = prepareP10bControlledMailbox, execute = executeP10bFirstMailboxQualification,
  clock = () => new Date(), resolveDatabasePath = (value) => value,
  closeIngress = requestP10bIngressClosure, guestReady = assertP10bGuestReady,
  requestShutdown = requestP10bGuestShutdown, completeHandoff = completeP10bGuestHandoff,
  processControl = process } = {}) {
  const controller = new AbortController();
  const pending = new Map();
  let storage; let sqliteClosed = true;
  let sequence = 0;
  let stopped = false;
  let stage = 'packet';
  const first = await channel.next();
  if (first?.kind !== 'run') throw new Error('A single explicit runtime packet is required');
  const packet = first.packet;
  let window; let databasePath; let handoff = false;
  const cancel = () => controller.abort();
  processControl.on('SIGUSR1', cancel);
  const send = (kind, values = {}) => channel.send({ version: 'p10b-control-v1', kind, ...values });
  const pump = (async () => {
    while (true) {
      const frame = await channel.next();
      if (!frame) throw new Error('Host control channel ended');
      if (frame.kind === 'cancel') { controller.abort(); continue; }
      if (frame.kind !== 'observation' || !pending.has(frame.id)) throw new Error('Unexpected host frame');
      const request = pending.get(frame.id);
      pending.delete(frame.id);
      frame.denied ? request.reject(new Error('Host observation denied')) : request.resolve(frame.observed);
    }
  })();
  pump.catch(() => {
    controller.abort();
    for (const request of pending.values()) request.reject(new Error('Host channel failed'));
    pending.clear();
  });
  const stopAndVerify = async () => {
    if (!stopped) {
      stopped = true;
      try { send('stop'); await channel.flush?.(); } catch { /* Retained guest candidate still precedes exit. */ }
      if (window) completeHandoff(window, databasePath);
    }
    // The guest guard exits to stop this Machine; only an external readback
    // can verify the stopped state and release the final artifact.
    return new Promise(() => {});
  };
  try {
    const { startedAt: _startedAt, ...hostPacket } = packet || {};
    validateP10bRuntimePacket(hostPacket, new Date(clock()).toISOString());
    stage = 'runtime-binding';
    validateRuntime(config, packet, runtime);
    window = p10bGuestWindow(packet);
    databasePath = resolveDatabasePath(packet.databasePath);
    stage = 'guardian-ready';
    await guestReady({ window, databasePath, clock: () => Date.parse(new Date(clock()).toISOString()) });
    stage = 'registration';
    writeP10bGuestRecord(`${databasePath}.p10b-${window.phase}-worker-process.json`, {
      windowDigest: sha256(stableCanonicalJson(window)), pid: processControl.pid });
    sqliteClosed = false;
    stage = 'storage-open';
    storage = createStorage(config);
    const initial = metadata(databasePath);
    if (packet.operation === 'prepare') {
      stage = 'fresh-start';
      const start = JSON.parse(fs.readFileSync(`${databasePath}.p10b-start.json`, 'utf8'));
      if (start.version !== 'p10b-fresh-start-v1' || start.sourceHead !== packet.sourceHead
        || start.app !== runtime.app || start.machineId !== runtime.machineId
        || Date.parse(start.startedAt) < Date.parse(packet.startedAt)
        || initial.transmissions || initial.authorizations || initial.opportunities || initial.submissions) {
        throw new Error('Fresh preparation provenance is unavailable');
      }
      stage = 'prepare';
      const prepared = await prepare({ storage, config, actor: packet.actor, now: new Date(clock()).toISOString(),
        synthetic: { runId: packet.runId, recipient: 'mathew@uckelegroup.com',
          permissionEvidenceId: packet.permissionEvidenceId, permissionEvidenceHash: packet.ownerPermissionDigest } });
      const identity = metadata(databasePath);
      if (identity.transmissions !== 1 || identity.authorizations !== 0) throw new Error('Unexpected preparation history');
      const receipt = { version: 'p10b-runtime-preparation-v1', app: runtime.app, machineId: runtime.machineId,
        sourceHead: packet.sourceHead, databaseIdentityHash: identity.databaseIdentityHash,
        runtimeConfigurationDigest: p10bPublicConfigurationDigest(config),
        providerIdentityDigest: packet.configurationEvidence.providerIdentityDigest,
        opportunityId: prepared.opportunityId, initialActivationId: prepared.initialActivationId,
        preparedAt: prepared.preparedAt, review: prepared.review, providerCalls: 0, productionReady: false };
      stage = 'sqlite-close';
      storage.close(); sqliteClosed = true; storage = null;
      stage = 'ingress-close';
      await closeIngress({ config, runtime, databasePath });
      receipt.ingressClosed = true; receipt.sqliteClosed = true;
      stage = 'artifact-write';
      fs.writeFileSync(`${databasePath}.p10b-preparation.json`, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      stage = 'shutdown-handoff';
      receipt.guestShutdown = await requestShutdown({ window, databasePath, outcome: receipt });
      handoff = true;
      send('prepared', { receipt });
      await stopAndVerify();
      return;
    }
    stage = 'qualification-binding';
    const retained = JSON.parse(fs.readFileSync(`${databasePath}.p10b-preparation.json`, 'utf8'));
    const startup = JSON.parse(fs.readFileSync(`${databasePath}.p10b-qualify-start.json`, 'utf8'));
    const manifest = packet.manifest;
    if (qualificationDigest(manifest) !== packet.reviewedDigest || initial.transmissions !== 1
      || initial.authorizations !== 0 || initial.databaseIdentityHash !== manifest.runtime.databaseIdentityHash
      || retained.databaseIdentityHash !== initial.databaseIdentityHash || retained.sourceHead !== packet.sourceHead
      || retained.providerIdentityDigest !== packet.configurationEvidence.providerIdentityDigest
      || retained.providerIdentityDigest !== manifest.runtime.providerIdentityDigest
      || retained.review.digest !== manifest.reviewDigest || retained.review.transmission.id !== manifest.transmissionId
      || retained.app !== runtime.app || retained.machineId !== runtime.machineId
      || retained.opportunityId !== packet.opportunityId || retained.initialActivationId !== packet.initialActivationId
      || startup.version !== 'p10b-one-start-v1' || startup.sourceHead !== packet.sourceHead
      || startup.databaseIdentityHash !== initial.databaseIdentityHash
      || !Number.isFinite(Date.parse(startup.startedAt))
      || Date.parse(startup.startedAt) < Date.parse(packet.startedAt)) {
      throw new Error('Prepared runtime binding or one-attempt history changed');
    }
    fs.writeFileSync(`${databasePath}.p10b-qualify-worker.json`, JSON.stringify({
      version: 'p10b-one-worker-v1', manifestDigest: packet.reviewedDigest,
      databaseIdentityHash: initial.databaseIdentityHash }), { flag: 'wx', mode: 0o600 });
    const observe = () => {
      if (controller.signal.aborted) throw new Error('Host cancelled the window');
      const identity = metadata(databasePath);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send('observe', { id, local: { app: runtime.app, machineId: runtime.machineId,
          sourceHead: runtime.sourceHead, ...identity, runtimeConfigurationDigest: p10bPublicConfigurationDigest(config) } });
      });
    };
    stage = 'qualify';
    await execute({ storage, config, actor: packet.actor, opportunityId: packet.opportunityId,
      initialActivationId: packet.initialActivationId, manifest, reviewedDigest: packet.reviewedDigest,
      supervisorTarget: packet.target, clock, observe, stopAndVerify, signal: controller.signal,
      lifecyclePollMs: 1000, onBeforeStop: async (candidate) => {
        stage = 'sqlite-close';
        storage.close(); sqliteClosed = true; storage = null;
        stage = 'ingress-close';
        await closeIngress({ config, runtime, databasePath });
        candidate.ingressClosed = true; candidate.sqliteClosed = true;
        stage = 'shutdown-handoff';
        candidate.guestShutdown = await requestShutdown({ window, databasePath, outcome: candidate,
          failure: Boolean(candidate.failureStage || candidate.cleanup?.errors?.length) });
        handoff = true;
        send('terminal', { candidate });
      } });
  } catch (error) {
    const failureDetails = p10bRuntimeFailure('worker', stage, error);
    // Publish primary failure provenance before bounded cleanup can consume
    // the remaining window or the guardian terminates this process.
    try { send('worker-failed', { failureDetails }); } catch { /* Guest watchdog retains ownership. */ }
    // The stop callback intentionally never returns on a real Machine. Close
    // this connection before invoking it, including failures before execution.
    try { if (storage) { storage.close(); sqliteClosed = true; } }
    catch { /* Failed acquisition or close retains cleanup uncertainty. */ }
    storage = null;
    try { await closeIngress({ config, runtime, databasePath: resolveDatabasePath(packet.databasePath) }); }
    catch { /* Guest cutoff still closes without releasing success. */ }
    if (window && !handoff) {
      try { await requestShutdown({ window, databasePath, failure: true,
        outcome: { sqliteClosed, failureStage: 'worker-failed', failureDetails, productionReady: false } }); }
      catch { /* Fixed guest cutoff owns termination even without acknowledgment. */ }
    }
    await stopAndVerify();
  } finally { storage?.close(); processControl.removeListener('SIGUSR1', cancel); }
}
