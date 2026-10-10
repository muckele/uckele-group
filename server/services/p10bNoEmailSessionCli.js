import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readP10bPublicJson, createP10bOperatorEvidence, createP10bRecoveryFilesystem, inspectP10bRecovery } from './p10bOperatorFiles.js';
import { assertP10bNoEmailApproval, runP10bNoEmailOperator, validateP10bBaselineConfig } from './p10bRuntimeOnlyOperator.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { recoverP10bAdmissionReservation } from './p10bAdmissionRecovery.js';
import { openP10bNativeMachineClient } from './p10bNativeMachineClient.js';
import { createP10bNoEmailBoundaries } from './p10bNoEmailBoundaries.js';
import { createP10bOperatorProcesses } from './p10bOperatorProcesses.js';
import { assertP10bReviewedCheckout } from './p10bOperatorSource.js';

export function assertP10bImagePrerequisite(session, image, now = Date.now()) {
  if (image?.version !== 'p10b-image-prerequisite-v1' || image.sourceHead !== session.sourceHead
    || image.imageDigest !== session.candidateImageDigest || image.immutableImage !== `registry.fly.io/uckele-group-p10b@${session.candidateImageDigest}`
    || image.buildCount !== 1 || image.pushCount !== 1 || image.registryManifestVerified !== true
    || !/^[a-f0-9]{64}$/.test(image.manifestEvidenceDigest || '')
    || !Number.isFinite(Date.parse(image.verifiedAt)) || Date.parse(image.verifiedAt) > now
    || now - Date.parse(image.verifiedAt) > 1800000) throw Error('Fresh exact approved image evidence required');
}
export async function runP10bNoEmailSessionCli(args, { read = readP10bPublicJson,
  openNative = openP10bNativeMachineClient, processes = createP10bOperatorProcesses(),
  createBoundaries = createP10bNoEmailBoundaries, clock = () => Date.now(),
  checkSource = assertP10bReviewedCheckout } = {}) {
  if (args.length === 2 && args[0] === '--validate-baseline') {
    const e = read(args[1]);
    if (e?.version !== 'p10b-public-baseline-preflight-v1' || e.app !== 'uckele-group-p10b'
      || e.machineId !== '0803730bd1d7e8' || e.volumeId !== 'vol_vwnkpex1k3yx9dnv'
      || !/^[a-f0-9]{40}$/.test(e.sourceHead || '') || !/^[A-Za-z0-9-]{1,80}$/.test(e.instanceId || '')
      || Object.keys(e).some(k => !['version', 'app', 'machineId', 'volumeId', 'sourceHead', 'instanceId', 'state',
        'observedAt', 'observedEnvironmentNames', 'fullConfigurationRetained', 'baselineConfig', 'baselineImageDigest', 'baselineConfigDigest'].includes(k))
      || e.state !== 'stopped' || e.fullConfigurationRetained !== true
      || !Number.isFinite(Date.parse(e.observedAt)) || Date.parse(e.observedAt) > clock()
      || clock() - Date.parse(e.observedAt) > 1800000
      || !Array.isArray(e.observedEnvironmentNames) || e.observedEnvironmentNames.some(k => typeof k !== 'string')
      || new Set(e.observedEnvironmentNames).size !== e.observedEnvironmentNames.length
      || stableCanonicalJson([...e.observedEnvironmentNames].sort()) !== stableCanonicalJson(Object.keys(e.baselineConfig?.env || {}).sort())) {
      throw Error('Complete fresh stopped public baseline required');
    }
    validateP10bBaselineConfig(e.baselineConfig, e.baselineImageDigest);
    if (e.baselineConfigDigest !== sha256(stableCanonicalJson(e.baselineConfig))) throw Error('Full public baseline digest mismatch');
    checkSource(e.sourceHead);
    return { status: 'PUBLIC_BASELINE_VALIDATED', baselineImageDigest: e.baselineImageDigest,
      baselineConfigDigest: sha256(stableCanonicalJson(e.baselineConfig)), observedAt: e.observedAt,
      sourceHead: e.sourceHead, instanceId: e.instanceId,
      environmentNameCount: e.observedEnvironmentNames.length, productionReady: false };
  }
  if (args.length === 2 && args[0] === '--validate-template') {
    const bundle = read(args[1]);
    if (bundle.version !== 'p10b-no-email-bundle-v1' || bundle.status !== 'SESSION_NOT_APPROVED'
      || bundle.approval?.approved !== false || bundle.approval.providerCalls !== 0 || bundle.approval.emails !== 0
      || bundle.session?.app !== 'uckele-group-p10b' || bundle.session.machineId !== '0803730bd1d7e8'
      || bundle.session.volumeId !== 'vol_vwnkpex1k3yx9dnv' || bundle.session.maximumStarts !== 2
      || bundle.session.maximumStartWindowMs !== 300000 || bundle.session.maximumStoppedConfigUpdates !== 3
      || bundle.session.productionReady !== false || bundle.session.globalAutomationPaused !== true
      || bundle.session?.candidateImageDigest !== null || bundle.session?.ownerPermissionDigest !== null) throw Error('Held template contract invalid');
    return { status: 'SESSION_NOT_APPROVED', executableImplementation: true, productionReady: false,
      missing: ['fresh exact source/image/registry evidence', 'owner no-email session and exclusive recovery approval',
        'normal Fly authentication', 'fresh independent stopped baseline and positive archived-reservation proof'] };
  }
  if (args.length !== 7 || !['--execute', '--run'].includes(args[0]) || args[1] !== '--bundle'
    || args[3] !== '--evidence' || args[5] !== '--native-client') throw Error('Expected --execute|--run --bundle FILE --evidence DIR --native-client FILE');
  const { session, approval, imageEvidence, status } = read(args[2]);
  if (status === 'SESSION_NOT_APPROVED') throw Error('Session is held');
  assertP10bNoEmailApproval(session, approval, clock()); assertP10bImagePrerequisite(session, imageEvidence, clock());
  checkSource(session.sourceHead);
  const evidence = createP10bOperatorEvidence(args[4]);
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')
    || evidence.has('p10b-runtime-only-operator-intent.json')) throw Error('Session held, closed or consumed');
  const nativeExecutable = path.resolve(args[6]); const directory = path.join(os.homedir(), '.uckele-group-p10b-host');
  const e = session.recovery;
  if (e?.directory !== directory || e.activePath !== path.join(directory, `${session.machineId}.active.json`)
    || e.attemptPath !== path.join(directory, `${e.packetDigest}.attempt.json`)
    || e.archivePath !== path.join(directory, `${session.machineId}.active.json.archived-uncertain-${session.nonce}.json`)
    || e.intentPath !== path.join(evidence.root, 'p10b-recovery-intent.json')
    || e.terminalPath !== path.join(evidence.root, 'p10b-recovery-terminal.json')) throw Error('Frozen recovery paths required');
  const verifier = fileURLToPath(new URL('../../scripts/run-p10b-admission-verifier.js', import.meta.url));
  let native;
  try {
    if (args[0] === '--execute') {
      evidence.write('p10b-recovery-verifier-input.json', { session, approval, nativeExecutable });
      native = await openNative({ executable: nativeExecutable, session, approval, readOnly: true, configs: [session.baselineConfig] });
      const baseline = await native.client();
      if (await native.close() !== true) throw Error('Recovery read client not reaped'); native = null;
      const input = path.join(evidence.root, 'p10b-recovery-verifier-input.json');
      await processes.command(process.execPath, [verifier, '--baseline', input, evidence.root], 10000);
      recoverP10bAdmissionReservation({ session, approval, baseline,
        independentBaseline: evidence.read('p10b-recovery-independent-baseline.json'), filesystem: createP10bRecoveryFilesystem(), clock });
      await processes.command(process.execPath, [verifier, '--archive', input, evidence.root], 5000);
    }
    const recovery = { intent: read(e.intentPath), terminal: read(e.terminalPath),
      verification: evidence.read('p10b-recovery-independent-verification.json') };
    return await runP10bNoEmailOperator({ session, approval, evidence, recovery,
      inspectRecovery: () => inspectP10bRecovery(session), clock,
      createBoundaries: input => createBoundaries({ ...input, evidence, recovery,
        inspectRecovery: () => inspectP10bRecovery(session), nativeExecutable }) });
  } finally { await processes.reap(); if (native) await native.reap(); }
}
