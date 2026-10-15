import { readP10bPublicJson, createP10bOperatorEvidence, inspectP10bRecovery } from '../server/services/p10bOperatorFiles.js';
import { assertP10bNoEmailApproval } from '../server/services/p10bRuntimeOnlyOperator.js';
import { verifyP10bAdmissionArchive } from '../server/services/p10bAdmissionRecovery.js';
import { assertP10bStoppedUpdateApproval, assertP10bStoppedUpdateHostBinding } from '../server/services/p10bStoppedUpdateContract.js';
import { openP10bNativeMachineClient, openP10bStoppedUpdateClient } from '../server/services/p10bNativeMachineClient.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { assertP10bNoEmailHostBinding } from '../server/services/p10bOperatorSource.js';
import { p10bInheritedAppTokenEnvironment } from '../server/services/p10bHostAuthentication.js';
try {
  if (process.argv.length !== 5 || !['--baseline', '--archive'].includes(process.argv[2])) throw Error();
  const input = readP10bPublicJson(process.argv[3]);
  const diagnostic = input.session?.version === 'p10b-stopped-update-session-v1';
  (diagnostic ? assertP10bStoppedUpdateApproval : assertP10bNoEmailApproval)(input.session, input.approval, Date.now());
  (diagnostic ? assertP10bStoppedUpdateHostBinding : assertP10bNoEmailHostBinding)(input.session);
  const evidence = createP10bOperatorEvidence(process.argv[4]);
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json') || evidence.has('p10b-stopped-update-closure.json')) throw Error();
  if (process.argv[2] === '--baseline') {
    const environment = p10bInheritedAppTokenEnvironment(input);
    const native = await (diagnostic ? openP10bStoppedUpdateClient : openP10bNativeMachineClient)({ executable: input.nativeExecutable,
      session: input.session, approval: input.approval, readOnly: true, configs: diagnostic ? [input.session.baselineConfig, input.session.diagnosticConfig] : [input.session.baselineConfig], environment });
    let reapVerified;
    try {
      const response = await native.client();
      const machine = diagnostic ? response.machine : response;
      evidence.write('p10b-recovery-independent-baseline.json', { machineDigest: sha256(stableCanonicalJson(machine)),
        independent: true, observedAt: new Date().toISOString(), verifierPid: process.pid });
    } finally { reapVerified = await native.reap(); }
    if (reapVerified !== true) throw Error('Native verifier not reaped');
  } else {
    const recovery = { intent: readP10bPublicJson(input.session.recovery.intentPath), terminal: readP10bPublicJson(input.session.recovery.terminalPath) };
    evidence.write('p10b-recovery-independent-verification.json', verifyP10bAdmissionArchive({ session: input.session,
      recovery, inspect: () => inspectP10bRecovery(input.session), verifierPid: process.pid }));
  }
} catch { process.stderr.write('Independent admission verification failed; preserve held evidence.\n'); process.exitCode = 1; }
