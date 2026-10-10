import { sha256, stableCanonicalJson } from '../utils/security.js';
import { P10B_GUEST_PROCESSES, p10bGuestWindow } from './p10bGuestShutdown.js';
import { P10B_PROVIDER_IDENTITY, p10bProviderIdentityDigest } from './p10bProviderIdentity.js';
import { validateP10bRuntimePacket } from './p10bQualificationHost.js';
import { createP10bRuntimeOnlyControl, assertP10bPreparationTerminal } from './p10bRuntimeOnlyControl.js';
import { assertP10bRecoveryAdmission } from './p10bAdmissionRecovery.js';
const digest = value => sha256(stableCanonicalJson(value));
export const P10B_RUNTIME_FLAGS = Object.freeze({ NODE_ENV: 'p10b', P10B_QUALIFICATION_RUNTIME: 'true', STORAGE_PROVIDER: 'sqlite',
  DEAL_HUNTER_CIM_PROVIDER_PROFILE: 'controlled-mailbox-v1', DEAL_HUNTER_CIM_PROVIDER_ENABLED: 'false',
  DEAL_HUNTER_CIM_OUTREACH_PAUSED: 'true', DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false',
  DEAL_HUNTER_CIM_AUTOMATION_PAUSED: 'true', DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: 'false',
  DEAL_HUNTER_DAILY_EMAIL_ENABLED: 'false', FOLLOW_UP_EMAIL_ENABLED: 'false', FOLLOW_UP_AI_ENABLED: 'false', DELIVERY_PROVIDER: 'console',
  DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL: 'P10B Sender <sender@p10b-e2e.uckelegroup.com>',
  DEAL_HUNTER_CIM_MAILBOX_REPLY_TO: 'replies@p10b-e2e.uckelegroup.com',
  DEAL_HUNTER_CIM_MAILBOX_INBOUND_DOMAIN: 'p10b-e2e.uckelegroup.com', DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS: 'mathew@uckelegroup.com' });
export const P10B_PUBLIC_ENV_NAMES = Object.freeze([...Object.keys(P10B_RUNTIME_FLAGS), 'PORT', 'HOST', 'TZ',
  'APP_BASE_URL', 'PUBLIC_BASE_URL', 'LOG_LEVEL', 'SQLITE_PATH', 'P10B_QUALIFICATION_PHASE', 'P10B_GUEST_WINDOW']);
const onlyKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(k => allowed.includes(k));

export function validateP10bNoEmailSession(s, now) {
  if (!onlyKeys(s, ['version', 'app', 'machineId', 'volumeId', 'sourceHead', 'nonce', 'candidateImageDigest', 'baselineImageDigest',
    'baselineConfig', 'ownerPermissionDigest', 'permissionEvidenceId', 'startedAt', 'sessionDeadline', 'maximumStarts',
    'maximumStartWindowMs', 'maximumStoppedConfigUpdates', 'maximumIncrementalUsd', 'maximumLocalBuilds', 'maximumImagePushes',
    'productionReady', 'globalAutomationPaused', 'configurationEvidence', 'budget', 'recovery', 'authenticationEvidence', 'nativeClientSha256'])
    || !onlyKeys(s.configurationEvidence, ['version', 'providerIdentity', 'providerIdentityDigest', 'flySecretMetadataDigest', 'verifiedAt'])
    || !onlyKeys(s.budget, ['priceEvidenceDigest', 'maximumUsdPerSecond', 'fixedIncrementalUsd'])
    || !onlyKeys(s.authenticationEvidence, ['version', 'ownerAttested', 'expiresAt'])
    || s.authenticationEvidence.version !== 'p10b-normal-authentication-coverage-v1'
    || s.authenticationEvidence.ownerAttested !== true || !Number.isFinite(Date.parse(s.authenticationEvidence.expiresAt))
    || Date.parse(s.authenticationEvidence.expiresAt) < Date.parse(s.sessionDeadline)
    || (s.recovery && !onlyKeys(s.recovery, ['directory', 'activePath', 'archivePath', 'attemptPath', 'intentPath', 'terminalPath',
      'expectedSha256', 'version', 'packetDigest', 'evidencePath', 'reservedAt']))
    || (s.recovery && (!/^[a-f0-9]{64}$/.test(s.recovery.packetDigest || '') || !/^[a-f0-9]{64}$/.test(s.recovery.expectedSha256 || '')
      || !Number.isFinite(Date.parse(s.recovery.reservedAt)) || new Date(s.recovery.reservedAt).toISOString() !== s.recovery.reservedAt
      || ('version' in s.recovery && s.recovery.version !== 'p10b-machine-owner-v1')))
    || s?.version !== 'p10b-no-email-session-v1' || s.app !== 'uckele-group-p10b' || s.machineId !== '0803730bd1d7e8'
    || ('volumeId' in s && s.volumeId !== 'vol_vwnkpex1k3yx9dnv')
    || !/^[a-f0-9]{40}$/.test(s.sourceHead || '') || !/^[a-f0-9]{24}$/.test(s.nonce || '')
    || !/^sha256:[a-f0-9]{64}$/.test(s.candidateImageDigest || '') || !/^sha256:[a-f0-9]{64}$/.test(s.baselineImageDigest || '')
    || !/^[a-f0-9]{64}$/.test(s.ownerPermissionDigest || '') || !/^[A-Za-z0-9_.:@-]{1,240}$/.test(s.permissionEvidenceId || '')
    || !/^[a-f0-9]{64}$/.test(s.nativeClientSha256 || '')
    || !Number.isFinite(now) || !Number.isFinite(Date.parse(s.startedAt)) || !Number.isFinite(Date.parse(s.sessionDeadline))
    || Date.parse(s.sessionDeadline) - Date.parse(s.startedAt) !== 3600000 || now < Date.parse(s.startedAt) || now >= Date.parse(s.sessionDeadline)
    || s.maximumStarts !== 2 || s.maximumStartWindowMs !== 300000 || s.maximumStoppedConfigUpdates !== 3
    || s.maximumIncrementalUsd !== 1 || s.maximumLocalBuilds !== 1 || s.maximumImagePushes !== 1
    || s.productionReady !== false || s.globalAutomationPaused !== true
    || s.baselineConfig?.image?.split('@')[1] !== s.baselineImageDigest
    || !s.configurationEvidence || s.configurationEvidence.version !== 'p10b-isolated-configuration-evidence-v2'
    || s.configurationEvidence.providerIdentityDigest !== p10bProviderIdentityDigest(P10B_PROVIDER_IDENTITY)
    || stableCanonicalJson(s.configurationEvidence.providerIdentity) !== stableCanonicalJson(P10B_PROVIDER_IDENTITY)
    || !/^[a-f0-9]{64}$/.test(s.configurationEvidence.flySecretMetadataDigest || '')
    || !Number.isFinite(Date.parse(s.configurationEvidence.verifiedAt)) || now < Date.parse(s.configurationEvidence.verifiedAt)
    || now - Date.parse(s.configurationEvidence.verifiedAt) > 86400000
    || !/^[a-f0-9]{64}$/.test(s.budget?.priceEvidenceDigest || '')
    || !Number.isFinite(s.budget.maximumUsdPerSecond) || s.budget.maximumUsdPerSecond < 0
    || !Number.isFinite(s.budget.fixedIncrementalUsd) || s.budget.fixedIncrementalUsd < 0
    || s.budget.fixedIncrementalUsd + 600 * s.budget.maximumUsdPerSecond >= 1) throw Error('Frozen no-email session invalid');
  const c = s.baselineConfig;
  if (!onlyKeys(c, ['image', 'env', 'restart', 'guest', 'mounts', 'services', 'init', 'processes', 'auto_destroy', 'schedule', 'checks', 'dns', 'metadata', 'metrics', 'stop_config'])
    || c.guest?.cpu_kind !== 'shared' || c.guest.cpus !== 1 || c.guest.memory_mb !== 512 || c.restart?.policy !== 'no'
    || c.mounts?.length !== 1 || c.mounts[0].volume !== 'vol_vwnkpex1k3yx9dnv' || c.mounts[0].path !== '/data'
    || c.services?.length !== 1 || c.services.some(v => v.autostart !== false || ![false, 'off'].includes(v.autostop) || v.internal_port !== 8787)
    || c.schedule || c.auto_destroy === true || c.files?.length || ['exec', 'cmd', 'entrypoint'].some(k => c.init?.[k]?.length)
    || Buffer.byteLength(stableCanonicalJson(c)) > 32768
    || Object.entries(c.env || {}).some(([k, v]) => !P10B_PUBLIC_ENV_NAMES.includes(k) || typeof v !== 'string'
      || v.length > 4096 || /(?:https?:\/\/[^/]*@|postgres(?:ql)?:|Bearer\s)/i.test(v))) {
    throw Error('Frozen baseline capacity or public configuration invalid');
  }
  return true;
}

export function createP10bRuntimePhase(input, label, now = Date.now()) {
  const s = structuredClone(input); validateP10bNoEmailSession(s, now);
  if (!['demo', 'prepare'].includes(label) || now + 360000 >= Date.parse(s.sessionDeadline)) throw Error('No-email phase outside frozen bounds');
  const packet = { version: 'p10b-runtime-packet-v3', operation: 'prepare', target: {
    app: s.app, machineId: s.machineId, imageDigest: s.candidateImageDigest }, sourceHead: s.sourceHead,
  databasePath: `/data/p10b-first-mailbox-${label === 'demo' ? 'watchdog' : 'nosend'}-${s.nonce}.sqlite`,
  actor: 'p10b-no-email-owner-approved', runId: `${label}-${s.nonce}`, permissionEvidenceId: s.permissionEvidenceId,
  ownerPermissionDigest: s.ownerPermissionDigest, guest: { issuedAt: new Date(now).toISOString(),
    stopAt: new Date(now + 300000).toISOString(), closureGraceMs: 30000, stopReserveMs: 30000 }, budget: s.budget };
  const window = p10bGuestWindow(packet);
  // This is the expected public description, not a credential observation.
  const publicConfiguration = { version: 'p10b-public-runtime-configuration-v1', isProduction: false,
    qualificationRuntime: true, qualificationPhase: 'prepare', providerProfile: 'controlled-mailbox-v1',
    guestWindowDigest: digest(window), from: P10B_RUNTIME_FLAGS.DEAL_HUNTER_CIM_MAILBOX_FROM_EMAIL,
    replyBase: 'replies@p10b-e2e.uckelegroup.com', domain: 'p10b-e2e.uckelegroup.com',
    allowedRecipients: ['mathew@uckelegroup.com'], databasePath: packet.databasePath,
    sendingCredentialPresent: true, readCredentialPresent: true, webhookCredentialPresent: true, hardOffVerified: true };
  packet.configurationEvidence = { ...s.configurationEvidence, runtimeConfigurationDigests: { prepare: digest(publicConfiguration) } };
  packet.configurationEvidenceDigest = digest(packet.configurationEvidence);
  validateP10bRuntimePacket(packet, new Date(now).toISOString());
  const config = structuredClone(s.baselineConfig);
  config.image = `registry.fly.io/uckele-group-p10b@${s.candidateImageDigest}`;
  config.env = { ...config.env, ...P10B_RUNTIME_FLAGS, P10B_QUALIFICATION_PHASE: 'prepare',
    SQLITE_PATH: packet.databasePath, P10B_GUEST_WINDOW: stableCanonicalJson(window) };
  config.processes = label === 'demo' ? [{ exec: ['node', '-e', 'setInterval(() => {}, 2147483647)'], ignore_app_secrets: true },
    structuredClone(P10B_GUEST_PROCESSES[1])] : structuredClone(P10B_GUEST_PROCESSES);
  return { label, packet, window, config };
}

export function assertP10bNoEmailApproval(session, approval, now) {
  validateP10bNoEmailSession(session, now);
  if (!onlyKeys(approval, ['version', 'approved', 'sessionDigest', 'ownerPermissionDigest', 'sourceHead', 'expiresAt',
    'recoveryApproved', 'exclusiveAdmissionWriters', 'providerCalls', 'emails']) || approval?.version !== 'p10b-no-email-approval-v1' || approval.approved !== true
    || approval.sessionDigest !== digest(session) || approval.ownerPermissionDigest !== session.ownerPermissionDigest
    || approval.sourceHead !== session.sourceHead || approval.expiresAt !== session.sessionDeadline
    || approval.recoveryApproved !== true || approval.exclusiveAdmissionWriters !== true
    || approval.providerCalls !== 0 || approval.emails !== 0) throw Error('Fresh exact no-email owner approval required');
}
export function assertP10bFrozenPhase(session, phase) {
  const issued = Date.parse(phase?.window?.issuedAt);
  if (!Number.isFinite(issued) || stableCanonicalJson(phase) !== stableCanonicalJson(createP10bRuntimePhase(session, phase?.label, issued))) {
    throw Error('Exact derived no-email phase required');
  }
  return true;
}

// All external actions are explicit boundaries. Production wiring uses the
// native authenticated helper and independent observer processes; tests use
// fake authentication/Machine actions, never the real admission directory.
export async function runP10bNoEmailOperator({ session: input, approval, evidence, recovery, inspectRecovery,
  createBoundaries, clock = () => Date.now() }) {
  const session = structuredClone(input);
  assertP10bNoEmailApproval(session, approval, clock());
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')
    || evidence.has('p10b-runtime-only-operator-intent.json')) throw Error('No-email session held, closed or consumed');
  assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
  evidence.write('p10b-runtime-only-operator-intent.json', { sessionDigest: digest(session), at: new Date(clock()).toISOString() });
  const control = createP10bRuntimeOnlyControl({ session, evidence, clock });
  let boundaries;
  let result; let failure = null; let restored = false; let activePhase; const configs = [];
  try {
    boundaries = await createBoundaries({ session, approval });
    let previous = session.baselineConfig;
    for (const label of ['demo', 'prepare']) {
      control.assertTime(label === 'demo' ? 660000 : 360000);
      assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
      const phase = createP10bRuntimePhase(session, label, clock()); configs.push(phase.config);
      activePhase = phase;
      evidence.write(`p10b-runtime-only-${label}-packet.json`, phase.packet);
      evidence.write(`p10b-runtime-only-${label}-window.json`, phase.window);
      evidence.write(`p10b-runtime-only-${label}-config.json`, phase.config);
      await boundaries.authorizePhase?.(phase);
      const machine = await control.guardedUpdate(boundaries.client, previous, phase.config, label);
      control.assertWindow(phase.window);
      const observer = await boundaries.startObserver({ phase, machine });
      if (observer?.attached !== true || observer.separateSession !== true || observer.instanceId !== machine.instance_id
        || observer.imageDigest !== session.candidateImageDigest) throw Error('Independent observer attachment required');
      evidence.write(`p10b-runtime-only-${label}-start-intent.json`, { at: new Date(clock()).toISOString(), window: phase.window });
      control.assertWindow(phase.window);
      if (label === 'demo') {
        const proof = await boundaries.demonstrate({ phase, observer, machine });
        if (proof?.success !== true || proof.windowDigest !== digest(phase.window) || proof.observerSurvived !== true
          || proof.primaryTerminationVerified !== true || proof.stopLatencyMs > 30000
          || ![proof.stopLatencyMs, proof.maximumMetadataPollGapMs, proof.maximumMetadataResponseGapMs].every(Number.isFinite)
          || proof.stopLatencyMs < 0 || proof.maximumMetadataPollGapMs > 1000 || proof.maximumMetadataResponseGapMs > 1000
          || proof.normalMachineExit !== true || proof.observerContinuous !== true || proof.unexpectedRestart !== false
          || proof.exitRecordCount !== 1) throw Error('Fresh guardian demonstration failed');
        evidence.write('p10b-runtime-only-demo-proof.json', proof);
      } else {
        const terminal = await boundaries.runPreparation({ phase, observer, machine });
        assertP10bPreparationTerminal(terminal);
        const p = terminal.result.preparation;
        if (terminal.result.packetDigest !== digest(phase.packet) || terminal.result.sourceHead !== session.sourceHead
          || p.app !== session.app || p.machineId !== session.machineId || p.sourceHead !== session.sourceHead
          || p.runtimeConfigurationDigest !== phase.packet.configurationEvidence.runtimeConfigurationDigests.prepare
          || p.guestShutdown.windowDigest !== digest(phase.window) || p.guestShutdown.stopAt !== phase.window.stopAt) {
          throw Error('Preparation result does not bind this phase');
        }
        result = terminal.result;
        evidence.write('p10b-runtime-only-preparation-accepted.json', { packetDigest: digest(phase.packet), resultDigest: digest(result) });
      }
      previous = phase.config;
    }
  } catch { failure = 'runtime-proof-failed'; }
  finally {
    if (boundaries) {
      let safeToRestore = true;
      try { if (activePhase && boundaries.settle && await boundaries.settle(activePhase) !== true) { safeToRestore = false; failure ||= 'stop-settlement-unverified'; } }
      catch { safeToRestore = false; failure ||= 'stop-settlement-unverified'; }
      try { if (await boundaries.reap() !== true) { safeToRestore = false; failure ||= 'local-reap-failed'; } }
      catch { safeToRestore = false; failure ||= 'local-reap-failed'; }
      if (safeToRestore) {
        try { await control.restoreBaseline(boundaries.client, session.baselineConfig, configs); restored = true; }
        catch { failure ||= 'restoration-unverified'; }
      }
      try { if (await boundaries.close() !== true) failure ||= 'native-close-failed'; } catch { failure ||= 'native-close-failed'; }
    }
    evidence.write('p10b-runtime-only-session-closure.json', { closedAt: new Date(clock()).toISOString(),
      sessionDigest: digest(session), failure, restored, success: !failure && Boolean(result), productionReady: false, globalAutomationPaused: true });
  }
  if (failure) throw Error('No-email runtime proof failed; preserve evidence and hold');
  return { success: true, restored, preparation: result, productionReady: false, globalAutomationPaused: true };
}
