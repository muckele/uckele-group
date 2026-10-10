import path from 'node:path';
import { readP10bPublicJson, inspectP10bRecovery, createP10bOperatorEvidence } from '../server/services/p10bOperatorFiles.js';
import { assertP10bRecoveryAdmission } from '../server/services/p10bAdmissionRecovery.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from '../server/services/p10bRuntimeOnlyOperator.js';
import { runFirstMailboxCli } from './run-p10b-first-mailbox.js';
import { stableCanonicalJson } from '../server/utils/security.js';
import { assertP10bReviewedCheckout } from '../server/services/p10bOperatorSource.js';
try {
  if (process.argv.length !== 3) throw Error();
  const { session, approval, phase, recovery } = readP10bPublicJson(process.argv[2]);
  assertP10bNoEmailApproval(session, approval, Date.now()); assertP10bFrozenPhase(session, phase);
  assertP10bReviewedCheckout(session.sourceHead);
  if (phase.label !== 'prepare') throw Error();
  const evidence = createP10bOperatorEvidence(path.dirname(path.resolve(process.argv[2])));
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')
    || evidence.read('p10b-runtime-only-demo-proof.json')?.success !== true) throw Error();
  assertP10bRecoveryAdmission({ session, recovery, inspect: () => inspectP10bRecovery(session) });
  evidence.write('p10b-runtime-only-prepare-actual-start.json', { at: new Date().toISOString() });
  const packetPath = path.join(evidence.root, 'p10b-runtime-only-prepare-packet.json');
  const retained = readP10bPublicJson(packetPath);
  if (retained.operation !== 'prepare' || stableCanonicalJson(retained) !== stableCanonicalJson(phase.packet)
    || Date.now() < Date.parse(phase.window.issuedAt) || Date.now() - Date.parse(phase.window.issuedAt) > 60000
    || Date.parse(phase.window.stopAt) - Date.now() < 240000) throw Error();
  const result = await runFirstMailboxCli(['--packet', packetPath,
    '--evidence-prefix', path.join(evidence.root, 'p10b-runtime-only-preparation')]);
  if (!result.success) process.exitCode = 1;
} catch { process.stderr.write('No-email preparation failed or held; preserve evidence.\n'); process.exitCode = 1; }
