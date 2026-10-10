import { readP10bPublicJson, createP10bOperatorEvidence, inspectP10bRecovery } from '../server/services/p10bOperatorFiles.js';
import { assertP10bNoEmailApproval } from '../server/services/p10bRuntimeOnlyOperator.js';
import { verifyP10bAdmissionArchive } from '../server/services/p10bAdmissionRecovery.js';
import { openP10bNativeMachineClient } from '../server/services/p10bNativeMachineClient.js';
import { sha256, stableCanonicalJson } from '../server/utils/security.js';
import { assertP10bReviewedCheckout } from '../server/services/p10bOperatorSource.js';
try {
  if (process.argv.length !== 5 || !['--baseline', '--archive'].includes(process.argv[2])) throw Error();
  const input = readP10bPublicJson(process.argv[3]);
  assertP10bNoEmailApproval(input.session, input.approval, Date.now());
  assertP10bReviewedCheckout(input.session.sourceHead);
  const evidence = createP10bOperatorEvidence(process.argv[4]);
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')) throw Error();
  if (process.argv[2] === '--baseline') {
    const native = await openP10bNativeMachineClient({ executable: input.nativeExecutable,
      session: input.session, approval: input.approval, readOnly: true, configs: [input.session.baselineConfig] });
    let reapVerified;
    try {
      const machine = await native.client();
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
