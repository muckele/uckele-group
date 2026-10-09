import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { P10B_QUALIFICATION_VERSION, qualificationDigest, validateP10bProviderRuntime,
  validateQualificationContract } from './p10bQualificationContract.js';
import { P10B_MACHINE_ID } from './p10bRuntime.js';
import { P10B_GUEST_PROCESSES, p10bGuestWindow } from './p10bGuestShutdown.js';
import { P10B_CONFIGURATION_EVIDENCE_VERSION, P10B_RUNTIME_PACKET_VERSION,
  p10bProviderIdentityDigest, validateP10bProviderIdentity } from './p10bProviderIdentity.js';

const owners = new Set();
const digest = (value) => sha256(stableCanonicalJson(value));
const hash = /^[0-9a-f]{64}$/;
const expectedFlags = {
  NODE_ENV: 'p10b', P10B_QUALIFICATION_RUNTIME: 'true', STORAGE_PROVIDER: 'sqlite',
  DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1',
  DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'false', DEAL_HUNTER_CIM_OUTREACH_PAUSED: 'true',
  DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false', DEAL_HUNTER_CIM_AUTOMATION_PAUSED: 'true',
  DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: 'false', DEAL_HUNTER_DAILY_EMAIL_ENABLED: 'false',
  FOLLOW_UP_EMAIL_ENABLED: 'false', FOLLOW_UP_AI_ENABLED: 'false', DELIVERY_PROVIDER: 'console',
  DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL: 'P10B Sender <sender@p10b-e2e.uckelegroup.com>',
  DEAL_HUNTER_CIM_MAILBOX_REPLY_TO: 'replies@p10b-e2e.uckelegroup.com',
  DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN: 'p10b-e2e.uckelegroup.com',
  DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'mathew@uckelegroup.com',
};

export function validateP10bRuntimePacket(packet, now) {
  const allowed = new Set(['version', 'operation', 'target', 'sourceHead', 'databasePath', 'actor',
    'runId', 'permissionEvidenceId', 'ownerPermissionDigest', 'configurationEvidence',
    'configurationEvidenceDigest', 'budget', 'manifest', 'reviewedDigest', 'opportunityId', 'initialActivationId', 'guest']);
  const evidence = packet?.configurationEvidence;
  const evidenceFields = new Set(['version', 'providerIdentity', 'providerIdentityDigest',
    'flySecretMetadataDigest', 'runtimeConfigurationDigests', 'verifiedAt']);
  const date = Date.parse(now);
  if (!packet || Object.keys(packet).some((key) => !allowed.has(key))
    || packet.version !== P10B_RUNTIME_PACKET_VERSION || !['prepare', 'qualify'].includes(packet.operation)
    || packet.target?.app !== 'uckele-group-p10b' || packet.target?.machineId !== P10B_MACHINE_ID
    || !/^sha256:[0-9a-f]{64}$/.test(packet.target?.imageDigest || '')
    || !/^[0-9a-f]{40}$/.test(packet.sourceHead || '')
    || !/^\/data\/p10b-first-mailbox-[a-z0-9-]{1,80}\.sqlite$/.test(packet.databasePath || '')
    || typeof packet.actor !== 'string' || !/^[A-Za-z0-9_.@-]{1,120}$/.test(packet.actor)
    || !hash.test(packet.ownerPermissionDigest || '') || !evidence
    || digest(evidence) !== packet.configurationEvidenceDigest
    || Object.keys(evidence).some((key) => !evidenceFields.has(key))
    || evidence.version !== P10B_CONFIGURATION_EVIDENCE_VERSION
    || !validateP10bProviderIdentity(evidence.providerIdentity)
    || p10bProviderIdentityDigest(evidence.providerIdentity) !== evidence.providerIdentityDigest
    || !hash.test(evidence.flySecretMetadataDigest || '')
    || !hash.test(evidence.runtimeConfigurationDigests?.[packet.operation] || '')
    || !Number.isFinite(date) || !Number.isFinite(Date.parse(evidence.verifiedAt))
    || Date.parse(evidence.verifiedAt) > date || date - Date.parse(evidence.verifiedAt) > 86400000
    || !hash.test(packet.budget?.priceEvidenceDigest || '')
    || !Number.isFinite(packet.budget?.maximumUsdPerSecond) || packet.budget.maximumUsdPerSecond < 0
    || !Number.isFinite(packet.budget?.fixedIncrementalUsd) || packet.budget.fixedIncrementalUsd < 0) {
    throw new Error('Runtime packet or isolated configuration evidence is invalid');
  }
  if (packet.operation === 'prepare') {
    if (!/^[a-z0-9-]{1,120}$/.test(packet.runId || '')
      || !/^[A-Za-z0-9_.:@-]{1,240}$/.test(packet.permissionEvidenceId || '')
      || packet.manifest) throw new Error('Preparation packet is invalid');
  } else {
    const m = packet.manifest;
    if (m?.version !== P10B_QUALIFICATION_VERSION || qualificationDigest(m) !== packet.reviewedDigest
      || !validateP10bProviderRuntime(m.runtime) || m.runtime.app !== packet.target.app
      || m.runtime.machineId !== packet.target.machineId || m.runtime.imageDigest !== packet.target.imageDigest
      || m.runtime.providerIdentityDigest !== evidence.providerIdentityDigest
      || m.ownerPermissionDigest !== packet.ownerPermissionDigest
      || m.configurationEvidenceDigest !== packet.configurationEvidenceDigest
      || typeof packet.opportunityId !== 'string' || typeof packet.initialActivationId !== 'string') {
      throw new Error('Qualification packet binding is invalid');
    }
  }
  const window = p10bGuestWindow(packet);
  if (date < Date.parse(window.issuedAt) || date >= Date.parse(window.stopAt)) throw new Error('Guest window is not current');
}

function validateMachine(machine, packet, state) {
  const config = machine?.config;
  const env = config?.env;
  if (machine?.id !== packet.target.machineId || machine.state !== state
    || machine.image_ref?.digest !== packet.target.imageDigest || machine.region !== 'ewr'
    || config?.guest?.cpu_kind !== 'shared' || config.guest.cpus !== 1 || config.guest.memory_mb !== 512
    || config.restart?.policy !== 'no' || !Array.isArray(config.services) || !config.services.length
    || config.schedule || config.auto_destroy === true
    || stableCanonicalJson(config.processes) !== stableCanonicalJson(P10B_GUEST_PROCESSES)
    || ['exec', 'cmd', 'entrypoint'].some((key) => config.init?.[key]?.length)
    || env.P10B_GUEST_WINDOW !== stableCanonicalJson(p10bGuestWindow(packet))
    || config.services.some((service) => service.autostart !== false || service.internal_port !== 8787
      || ![undefined, false, 'off'].includes(service.autostop))
    || !Array.isArray(config.mounts) || config.mounts.length !== 1
    || config.mounts[0].volume !== 'vol_vwnkpex1k3yx9dnv' || config.mounts[0].path !== '/data'
    || Object.entries(expectedFlags).some(([key, value]) => env?.[key] !== value)
    || env.P10B_QUALIFICATION_PHASE !== packet.operation || env.SQLITE_PATH !== packet.databasePath
    || ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_REPLY_TO', 'RESEND_INBOUND_DOMAIN', 'EMAIL_WEBHOOK_SECRET']
      .some((key) => Boolean(env[key]))) throw new Error('Machine state or isolated configuration changed');
}

function validateGuestHandoff(outcome, packet) {
  const { guestShutdown, ...retained } = outcome || {};
  if (guestShutdown?.version !== 'p10b-guest-shutdown-receipt-v1'
    || guestShutdown.windowDigest !== digest(p10bGuestWindow(packet))
    || guestShutdown.stopAt !== packet.guest.stopAt || guestShutdown.handoffVerified !== true
    || guestShutdown.outcomeDigest !== digest(retained)) throw new Error('Guest handoff is unverified');
  return guestShutdown;
}

function validateGuestClosure(outcome, packet) {
  const guestShutdown = validateGuestHandoff(outcome, packet);
  if (guestShutdown.cleanupUncertain !== false
    || guestShutdown.authorityClosed !== true || guestShutdown.ingressClosed !== true
    || guestShutdown.workerSqliteClosed !== true || guestShutdown.failure !== false) throw new Error('Guest cleanup is unverified');
}

function finalArtifact(candidate, packet, stop, now) {
  validateGuestClosure(candidate, packet);
  const proof = candidate?.proof;
  if (candidate?.version !== 'p10b-pre-stop-candidate-v1' || candidate.manifestDigest !== packet.reviewedDigest
    || candidate.lifecycleVerified !== false || candidate.productionReady !== false
    || candidate.failureStage || candidate.outcome !== 'accepted' || candidate.providerCalls !== 1
    || candidate.cleanup?.errors?.length !== 0 || candidate.cleanup.authorizationClosed !== true
    || candidate.cleanup.activationClosed !== true || candidate.cleanup.pauseRestored !== true
    || candidate.cleanup.hardOffRestored !== true || !proof
    || candidate.ingressClosed !== true
    || proof.version !== 'p10b-lifecycle-proof-candidate-v1' || proof.lifecycleVerified !== false
    || proof.productionReady !== false || proof.manifestDigest !== packet.reviewedDigest
    || proof.payloadDigest !== packet.manifest.payloadDigest
    || proof.transmissionIdHash !== sha256(packet.manifest.transmissionId)
    || ['deliveryReceiptDigest', 'replyReceiptDigest', 'reconciliationDigest', 'inboundContentDigest', 'terminalEvidenceDigest']
      .some((key) => !hash.test(proof[key] || ''))
    || !Number.isFinite(Date.parse(proof.generatedAt))
    || Date.parse(proof.generatedAt) < Date.parse(packet.manifest.issuedAt)
    || Date.parse(proof.generatedAt) > Date.parse(now)
    || proof.expiresAt !== new Date(Math.min(Date.parse(packet.manifest.expiresAt),
      Date.parse(packet.manifest.issuedAt) + packet.manifest.maximumRuntimeMs)).toISOString()
    || Date.parse(now) >= Date.parse(proof.expiresAt)) throw new Error('Worker lifecycle candidate is incomplete or expired');
  const { digest: supplied, ...canonical } = proof;
  if (digest(canonical) !== supplied) throw new Error('Worker candidate digest changed');
  const result = { ...canonical, version: 'p10b-verified-lifecycle-artifact-v1', generatedAt: now,
    lifecycleVerified: true, productionReady: false, stoppedVerified: true, stopReceiptDigest: digest(stop) };
  return { ...result, digest: digest(result) };
}

// The host starts only the reviewed Machine and verifies its stopped state.
// The independent guest guard owns shutdown. The remote worker supplies
// local SQLite/receipt evidence over existing authenticated SSH; this host
// never copies or mounts the live database, forwards credentials, or sends mail.
export async function runP10bQualificationHost({ packet: inputPacket, adapter, evidencePath,
  clock = () => new Date(), stopTimeoutMs = 30000, closureGraceMs = 30000,
  admission = owners, admissionDirectory = path.join(os.homedir(), '.uckele-group-p10b-host'), signal } = {}) {
  // A frozen request prevents caller mutation from changing command targets
  // after ownership transfers. The executable always uses the shared admission.
  const packet = structuredClone(inputPacket);
  const target = packet?.target;
  if (target?.app !== 'uckele-group-p10b' || target?.machineId !== P10B_MACHINE_ID
    || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 30000
    || !Number.isSafeInteger(closureGraceMs) || closureGraceMs < 1 || closureGraceMs > 30000) {
    throw new Error('Explicit isolated host stop ownership is required');
  }
  const key = `${target.app}:${target.machineId}`;
  if (admission.has(key)) throw new Error('Host supervisor already owns this Machine');
  admission.add(key);
  const lockPath = path.join(admissionDirectory, `${target.machineId}.active.json`);
  let lockOwned = false;
  const operations = new AbortController();
  let reserved = false;
  let worker;
  let stopPromise;
  let candidate;
  let prepared;
  let guestHandoffVerified = false;
  let failure;
  let stage = 'preflight';
  let startIssued = false;
  let startCompleted = false;
  let reads = 0;
  let cancelTimer;
  let stopTimer;
  const startedWall = Date.now();
  let startedAt;
  let maximumMs = 300000;
  let deadline = startedWall + maximumMs;
  const cost = () => packet.budget.fixedIncrementalUsd
    + (Date.now() - startedWall) / 1000 * packet.budget.maximumUsdPerSecond;
  const bounded = async (task, milliseconds, signal) => {
    let timer;
    let abort;
    try {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0 || signal?.aborted) {
        throw new Error('Host operation expired');
      }
      return await Promise.race([Promise.resolve().then(task), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Host operation timed out')), milliseconds);
        if (signal) {
          abort = () => reject(new Error('Host operation cancelled'));
          signal.addEventListener('abort', abort, { once: true });
        }
      })]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  };
  const readMachine = async () => {
    if (++reads > 2048) throw new Error('Host read limit reached');
    return bounded(() => adapter.getMachine(target, { signal: operations.signal }),
      Math.min(10000, deadline - Date.now()), operations.signal);
  };
  const readSecrets = async () => {
    if (++reads > 2048) throw new Error('Host read limit reached');
    const value = await bounded(() => adapter.getSecretMetadata(target, { signal: operations.signal }),
      Math.min(10000, deadline - Date.now()), operations.signal);
    if (digest(value) !== packet.configurationEvidence.flySecretMetadataDigest) throw new Error('Staged secret metadata changed');
  };
  const stopOnce = () => {
    if (!stopPromise) stopPromise = (async () => {
      stage = 'stopping';
      // Reap local commands; the independent guest remains the sole shutdown
      // owner. An early host failure still waits through its frozen cutoff.
      operations.abort();
      // Execution expiry closes permission, never the responsibility to stop.
      const stopDeadline = startIssued && !guestHandoffVerified
        ? Math.max(Date.now() + stopTimeoutMs, deadline) : Date.now() + stopTimeoutMs;
      const stopping = new AbortController();
      const timer = setTimeout(() => stopping.abort(), Math.max(1, stopDeadline - Date.now()));
      let verified = false;
      let reaped = !worker;
      let controlsReaped = true;
      try {
        if (typeof adapter.reap === 'function') {
          controlsReaped = await bounded(() => adapter.reap(), stopDeadline - Date.now()) === true;
        }
        do {
          const machine = await bounded(() => adapter.getMachine(target, { signal: stopping.signal }),
            Math.min(1000, stopDeadline - Date.now()), stopping.signal);
          verified = machine?.id === target.machineId && machine.state === 'stopped'
            && machine.image_ref?.digest === target.imageDigest;
          if (!verified) await bounded(() => new Promise((resolve) => setTimeout(resolve, 20)),
            stopDeadline - Date.now(), stopping.signal);
        } while (!verified && Date.now() < stopDeadline);
      } catch { /* Retain uncertainty; this host has no competing stop action. */ }
      finally { clearTimeout(timer); stopping.abort(); }
      if (worker) {
        try { reaped = await bounded(() => worker.terminate(), stopDeadline - Date.now()) === true; }
        catch { reaped = false; }
      }
      if (typeof adapter.reap === 'function') {
        try { controlsReaped = (await bounded(() => adapter.reap(), stopDeadline - Date.now()) === true) && controlsReaped; }
        catch { controlsReaped = false; }
      }
      const receipt = { app: target.app, machineId: target.machineId, imageDigest: target.imageDigest,
        stoppedVerified: verified, processReaped: reaped && controlsReaped,
        stopUncertain: !verified || !reaped || !controlsReaped || (startIssued && !startCompleted),
        startUncertain: startIssued && !startCompleted,
        observedAt: new Date().toISOString() };
      if (!receipt.stopUncertain) {
        try {
          fs.renameSync(lockPath, `${lockPath}.${digest(packet)}.closed.json`);
          admission.delete(key); lockOwned = false;
        } catch { receipt.stopUncertain = true; }
      }
      return receipt;
    })();
    return stopPromise;
  };
  const cancel = () => {
    failure ||= 'host_deadline';
    if (stage !== 'stopping') stage = 'closing';
    operations.abort();
    try { worker?.channel.send({ version: 'p10b-control-v1', kind: 'cancel' }); } catch { /* stop owner remains active */ }
  };
  let stop;
  const onAbort = () => { failure ||= 'host_cancelled'; cancel(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    fs.mkdirSync(admissionDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(admissionDirectory, `${digest(packet)}.attempt.json`),
      JSON.stringify({ packetDigest: digest(packet), evidencePath }), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(lockPath, JSON.stringify({ version: 'p10b-machine-owner-v1',
      packetDigest: digest(packet), evidencePath, reservedAt: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 });
    lockOwned = true;
    // Reserve before consulting an injected clock or configuration. A failed
    // clock still follows the bounded stop path and leaves durable evidence.
    fs.writeFileSync(`${evidencePath}.attempt.json`, JSON.stringify({ version: 'p10b-host-attempt-v1',
      packetDigest: digest(packet), app: target.app, machineId: target.machineId,
      reservedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    reserved = true;
    startedAt = new Date(clock()).toISOString();
    validateP10bRuntimePacket(packet, startedAt);
    maximumMs = Date.parse(packet.guest.stopAt) - Date.parse(startedAt);
    if (!Number.isFinite(maximumMs) || maximumMs <= closureGraceMs + stopTimeoutMs
      || packet.guest.closureGraceMs !== closureGraceMs || packet.guest.stopReserveMs !== stopTimeoutMs
      || packet.budget.fixedIncrementalUsd + maximumMs / 1000 * packet.budget.maximumUsdPerSecond > 0.90) {
      throw new Error('Runtime or conservative aggregate budget is not bounded');
    }
    deadline = startedWall + maximumMs;
    cancelTimer = setTimeout(cancel, Math.max(1, deadline - Date.now() - closureGraceMs - stopTimeoutMs));
    stopTimer = setTimeout(() => { cancel(); void stopOnce(); }, Math.max(1, deadline - Date.now() - stopTimeoutMs));
    if (signal?.aborted) onAbort();
    validateMachine(await readMachine(), packet, 'stopped');
    await readSecrets();
    stage = 'starting';
    startIssued = true;
    await bounded(() => adapter.startMachine(target, { signal: operations.signal }),
      Math.min(10000, deadline - Date.now()), operations.signal);
    startCompleted = true;
    validateMachine(await readMachine(), packet, 'started');
    stage = 'worker';
    await bounded(async () => {
      const opened = await adapter.openWorker(target, { signal: operations.signal });
      if (operations.signal.aborted || stopPromise) {
        await opened.terminate();
        throw new Error('Worker opened after cancellation');
      }
      worker = opened;
    }, Math.min(10000, deadline - Date.now()), operations.signal);
    worker.channel.send({ version: 'p10b-control-v1', kind: 'run', packet: { ...packet, startedAt } });
    while (true) {
      const frame = await bounded(() => worker.channel.next(), deadline - Date.now() - stopTimeoutMs,
        operations.signal);
      if (!frame || stage === 'stopping') throw new Error('Worker control ended unexpectedly');
      if (frame.kind === 'observe' && packet.operation === 'qualify' && !failure) {
        const local = frame.local;
        if (!Number.isSafeInteger(frame.id) || frame.id < 1 || local?.app !== target.app
          || local.machineId !== target.machineId || local.sourceHead !== packet.sourceHead
          || local.databaseIdentityHash !== packet.manifest.runtime.databaseIdentityHash
          || local.transmissions !== 1 || ![0, 1].includes(local.authorizations)
          || local.runtimeConfigurationDigest !== packet.configurationEvidence.runtimeConfigurationDigests.qualify) {
          throw new Error('Worker local identity changed');
        }
        validateMachine(await readMachine(), packet, 'started');
        await readSecrets();
        const observed = { runtime: { ...packet.manifest.runtime }, domain: packet.manifest.domain,
          ownerPermissionDigest: packet.ownerPermissionDigest,
          configurationEvidenceDigest: packet.configurationEvidenceDigest,
          freshDatabase: true, stopSupervised: true, incrementalUsd: cost() };
        if (observed.incrementalUsd >= 0.90 || !validateQualificationContract({ manifest: packet.manifest,
          reviewedDigest: packet.reviewedDigest, observed, now: new Date(clock()).toISOString() }).valid) {
          throw new Error('Qualification observation is no longer valid');
        }
        worker.channel.send({ version: 'p10b-control-v1', kind: 'observation', id: frame.id, observed });
      } else if (frame.kind === 'terminal' && packet.operation === 'qualify' && !candidate) {
        candidate = frame.candidate;
        validateGuestHandoff(candidate, packet); guestHandoffVerified = true;
      } else if (frame.kind === 'prepared' && packet.operation === 'prepare' && !prepared) {
        prepared = frame.receipt;
        validateGuestClosure(prepared, packet);
        guestHandoffVerified = true;
        if (prepared?.version !== 'p10b-runtime-preparation-v1' || prepared.sourceHead !== packet.sourceHead
          || prepared.app !== target.app || prepared.machineId !== target.machineId
          || !hash.test(prepared.databaseIdentityHash || '') || prepared.providerCalls !== 0
          || prepared.productionReady !== false || prepared.ingressClosed !== true
          || prepared.providerIdentityDigest !== packet.configurationEvidence.providerIdentityDigest
          || prepared.runtimeConfigurationDigest !== packet.configurationEvidence.runtimeConfigurationDigests.prepare) {
          throw new Error('Preparation receipt changed');
        }
      } else if (frame.kind === 'stop' && (candidate || prepared)) break;
      else throw new Error('Unexpected worker control output');
    }
  } catch { failure ||= stage; }
  finally {
    signal?.removeEventListener('abort', onAbort);
    clearTimeout(cancelTimer); clearTimeout(stopTimer);
    if (lockOwned) {
      if (failure && worker && !candidate && !prepared && !stopPromise) {
        cancel();
        try {
          const frame = await bounded(() => worker.channel.next(), Math.min(closureGraceMs, deadline - Date.now() - stopTimeoutMs));
          if (frame?.kind === 'terminal') {
            candidate = frame.candidate;
            validateGuestHandoff(candidate, packet); guestHandoffVerified = true;
          }
        } catch { /* Closure unavailable: stop, retain and fail closed. */ }
      }
      stop = await stopOnce();
    } else admission.delete(key);
  }
  let artifact;
  if (!failure && !stop?.stopUncertain && packet.operation === 'qualify') {
    try { artifact = finalArtifact(candidate, packet, stop, new Date(clock()).toISOString()); }
    catch { failure = 'terminal-verification'; }
  }
  const result = { version: 'p10b-host-result-v1', operation: packet.operation, packetDigest: digest(packet),
    sourceHead: packet.sourceHead, startedAt: startedAt || null, finishedAt: new Date().toISOString(),
    ...stop, failureStage: failure || null, productionReady: false,
    lifecycleVerified: Boolean(artifact), success: !failure && !stop?.stopUncertain
      && (packet.operation === 'prepare' ? Boolean(prepared) : Boolean(artifact)),
    conservativeIncrementalUsd: reserved && packet.budget ? cost() : null,
    ...(artifact ? { artifact } : {}), ...(prepared ? { preparation: prepared } : {}) };
  if (reserved) fs.writeFileSync(`${evidencePath}.result.json`, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
}
