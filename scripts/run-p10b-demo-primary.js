import { createP10bOperatorProcesses } from '../server/services/p10bOperatorProcesses.js';
import path from 'node:path';
import { readP10bPublicJson, inspectP10bRecovery, createP10bOperatorEvidence } from '../server/services/p10bOperatorFiles.js';
import { assertP10bRecoveryAdmission } from '../server/services/p10bAdmissionRecovery.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from '../server/services/p10bRuntimeOnlyOperator.js';
import { openP10bNativeMachineClient } from '../server/services/p10bNativeMachineClient.js';
import { stableCanonicalJson } from '../server/utils/security.js';
import { assertP10bReviewedCheckout } from '../server/services/p10bOperatorSource.js';
const processes = createP10bOperatorProcesses();
try {
  if (process.argv.length !== 3) throw Error();
  const { session, approval, phase, recovery, flyExecutable, nativeExecutable, machine } = readP10bPublicJson(process.argv[2]);
  assertP10bNoEmailApproval(session, approval, Date.now());
  assertP10bReviewedCheckout(session.sourceHead);
  assertP10bFrozenPhase(session, phase); if (phase.label !== 'demo') throw Error();
  const evidence = createP10bOperatorEvidence(path.dirname(path.resolve(process.argv[2])));
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')) throw Error();
  assertP10bRecoveryAdmission({ session, recovery, inspect: () => inspectP10bRecovery(session) });
  const window = phase.window;
  if (Date.now() < Date.parse(window.issuedAt) || Date.now() - Date.parse(window.issuedAt) > 60000
    || Date.parse(window.stopAt) - Date.now() < 240000) throw Error();
  const native = await openP10bNativeMachineClient({ executable: nativeExecutable, session, approval, readOnly: true, configs: [phase.config] });
  let checked; let reaped;
  try { checked = await native.client(); } finally { reaped = await native.reap(); }
  if (!reaped || checked.state !== 'stopped' || checked.instance_id !== machine.instance_id || stableCanonicalJson(checked.config) !== stableCanonicalJson(phase.config)) throw Error();
  evidence.write('p10b-runtime-only-demo-actual-start.json', { at: new Date().toISOString(), instanceId: checked.instance_id });
  if (Date.now() - Date.parse(window.issuedAt) > 60000 || Date.parse(window.stopAt) - Date.now() < 240000) throw Error();
  await processes.command(flyExecutable, ['machine', 'start', session.machineId, '--app', session.app], 10000);
  const readiness = JSON.parse(await processes.command(flyExecutable, ['ssh', 'console', '--app', session.app,
    '--machine', session.machineId, '--quiet', '--command', 'node /app/scripts/read-p10b-public-readiness.js'], 5000));
  process.send?.(readiness);
  setInterval(() => {}, 1000);
} catch { await processes.reap(); process.stderr.write('Demo primary failed; no proof admitted.\n'); process.exitCode = 1; }
