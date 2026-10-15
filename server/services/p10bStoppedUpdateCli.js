import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readP10bPublicJson, createP10bOperatorEvidence, createP10bRecoveryFilesystem, inspectP10bRecovery } from './p10bOperatorFiles.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bRecoveryAdmission, recoverP10bAdmissionReservation } from './p10bAdmissionRecovery.js';
import { openP10bStoppedUpdateClient } from './p10bNativeMachineClient.js';
import { createP10bOperatorProcesses } from './p10bOperatorProcesses.js';
import { assertP10bReviewedCheckout, assertP10bFlyExecutable } from './p10bOperatorSource.js';
import { createP10bAppTokenContext } from './p10bHostAuthentication.js';
import { assertP10bImagePrerequisite } from './p10bNoEmailSessionCli.js';
import { assertP10bStoppedUpdateApproval, assertP10bStoppedUpdateHostBinding } from './p10bStoppedUpdateContract.js';
import { runP10bStoppedUpdateDiagnostic } from './p10bStoppedUpdateDiagnostic.js';

// There is deliberately no --run recovery bypass or qualification continuation.
export async function runP10bStoppedUpdateCli(args, { read = readP10bPublicJson,
  openNative = openP10bStoppedUpdateClient, processes, clock = Date.now,
  checkSource = assertP10bReviewedCheckout, createAuth = createP10bAppTokenContext,
  createEvidence = createP10bOperatorEvidence, inspectRecovery = inspectP10bRecovery,
  recoveryFilesystem = createP10bRecoveryFilesystem } = {}) {
  if (args.length !== 7 || args[0] !== '--execute' || args[1] !== '--bundle'
    || args[3] !== '--evidence' || args[5] !== '--native-client') throw Error('Expected exact diagnostic execution arguments');
  const enteredAt = clock();
  if (!Number.isFinite(enteredAt)) throw Error('Diagnostic entry clock required');
  const { version, session, approval, imageEvidence, status } = read(args[2]);
  if (version !== 'p10b-stopped-update-bundle-v2' || status !== 'OWNER_APPROVED_STOPPED_UPDATE_DIAGNOSTIC') throw Error('Diagnostic is held');
  assertP10bStoppedUpdateApproval(session, approval, clock()); assertP10bImagePrerequisite(session, imageEvidence, clock());
  assertP10bStoppedUpdateHostBinding(session, checkSource); assertP10bFlyExecutable(session);
  const runDeadline = Math.min(enteredAt + session.maximumRunMs, Date.parse(session.sessionDeadline));
  const evidence = createEvidence(args[4]);
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-stopped-update-closure.json')
    || evidence.has('p10b-stopped-update-intent.json') || evidence.has('p10b-stopped-update-auth-closure.json')) throw Error('Diagnostic held or consumed');
  const nativeExecutable = path.resolve(args[6]); const directory = path.join(os.homedir(), '.uckele-group-p10b-host');
  const e = session.recovery;
  if (e?.directory !== directory || e.activePath !== path.join(directory, `${session.machineId}.active.json`)
    || e.attemptPath !== path.join(directory, `${e.packetDigest}.attempt.json`)
    || e.archivePath !== path.join(directory, `${session.machineId}.active.json.archived-uncertain-${session.nonce}.json`)
    || e.intentPath !== path.join(evidence.root, 'p10b-recovery-intent.json')
    || e.terminalPath !== path.join(evidence.root, 'p10b-recovery-terminal.json')) throw Error('Frozen recovery paths required');
  const verifier = fileURLToPath(new URL('../../scripts/run-p10b-admission-verifier.js', import.meta.url));
  if (clock() < enteredAt || clock() + 40000 >= runDeadline) throw Error('Original diagnostic entry cutoff exhausted');
  const auth = createAuth({ session, approval, clock });
  const natives = []; let initializationUncertain = false; let result; let failed = false; let cleanupHeld = false;
  let stage = 'recovery-native-initialization';
  const authenticatedNative = async readOnly => {
    if (clock() + 40000 >= runDeadline) throw Error('Diagnostic admission cutoff');
    try {
      const client = await openNative({ executable: nativeExecutable, session, approval, readOnly,
        recoveryVerified: !readOnly, configs: [session.baselineConfig, session.diagnosticConfig], environment: auth.environment });
      natives.push(client); return client;
    } catch (error) {
      if (error?.reapVerified !== true) initializationUncertain = true;
      throw Error('Diagnostic native admission failed');
    }
  };
  try {
    processes ||= createP10bOperatorProcesses({ environment: auth.environment });
    evidence.write('p10b-recovery-verifier-input.json', { session, approval, nativeExecutable });
    const baselineClient = await authenticatedNative(true);
    stage = 'recovery-baseline-read';
    const { machine: baseline } = await baselineClient.client('GET', undefined, 1000);
    stage = 'recovery-native-reap';
    if (await baselineClient.reap() !== true) throw Error('Recovery read client not reaped');
    const input = path.join(evidence.root, 'p10b-recovery-verifier-input.json');
    stage = 'recovery-independent-baseline';
    await processes.command(process.execPath, [verifier, '--baseline', input, evidence.root], 10000);
    stage = 'recovery-archive';
    recoverP10bAdmissionReservation({ session, approval, baseline,
      independentBaseline: evidence.read('p10b-recovery-independent-baseline.json'), filesystem: recoveryFilesystem(), clock });
    stage = 'recovery-independent-archive';
    await processes.command(process.execPath, [verifier, '--archive', input, evidence.root], 5000);
    const recovery = { intent: read(e.intentPath), terminal: read(e.terminalPath),
      verification: evidence.read('p10b-recovery-independent-verification.json') };
    stage = 'stopped-update-diagnostic';
    result = await runP10bStoppedUpdateDiagnostic({ session, approval, evidence, clock, runDeadline,
      assertAdmission: () => assertP10bRecoveryAdmission({ session, recovery, inspect: () => inspectRecovery(session), now: clock() }),
      createClient: () => authenticatedNative(false) });
  } catch { failed = true; }
  finally {
    let reaped = !initializationUncertain;
    try { if (await processes?.reap() !== true) reaped = false; } catch { reaped = false; }
    for (const client of natives) { try { if (await client.reap() !== true) reaped = false; } catch { reaped = false; } }
    let cleanupVerified = false;
    try { cleanupVerified = auth.cleanup({ reaped }) === true; } catch { /* preserve private context when reaping is uncertain */ }
    evidence.write('p10b-stopped-update-auth-closure.json', { sessionDigest: sha256(stableCanonicalJson(session)),
      closedAt: new Date(clock()).toISOString(), directReapVerified: reaped, reapVerified: reaped && cleanupVerified, cleanupVerified,
      failureStage: failed ? stage : (!reaped ? 'local-client-reap' : (!cleanupVerified ? 'private-auth-cleanup' : null)),
      success: !failed && Boolean(result?.success) && reaped && cleanupVerified, productionReady: false,
      ...(!cleanupVerified && auth.environment.FLY_CONFIG_DIR ? { privateAuthDirectory: auth.environment.FLY_CONFIG_DIR } : {}) });
    cleanupHeld = !reaped || !cleanupVerified;
  }
  if (cleanupHeld) throw Error('Private authentication cleanup held; preserve evidence');
  if (failed) throw Error('Stopped-update diagnostic failed; preserve evidence');
  return result;
}
