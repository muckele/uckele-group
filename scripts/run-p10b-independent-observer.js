import fs from 'node:fs';
import path from 'node:path';
import { readP10bPublicJson, createP10bOperatorEvidence } from '../server/services/p10bOperatorFiles.js';
import { runP10bIndependentObserver } from '../server/services/p10bIndependentObserver.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from '../server/services/p10bRuntimeOnlyOperator.js';
import { assertP10bReviewedCheckout } from '../server/services/p10bOperatorSource.js';

// Separate OS session, own read-only native connection, own log stream. Only
// sanitized lifecycle records are published to this exclusive public file.
try {
  if (process.argv.length !== 4) throw Error();
  const input = readP10bPublicJson(process.argv[2]);
  assertP10bNoEmailApproval(input.session, input.approval, Date.now()); assertP10bFrozenPhase(input.session, input.phase);
  assertP10bReviewedCheckout(input.session.sourceHead);
  const evidence = createP10bOperatorEvidence(path.dirname(path.resolve(process.argv[2])));
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')) throw Error();
  if (path.dirname(path.resolve(process.argv[3])) !== evidence.root) throw Error();
  const fd = fs.openSync(process.argv[3], 'wx', 0o600);
  try {
    const success = await runP10bIndependentObserver({ ...input,
      record: row => fs.writeSync(fd, `${JSON.stringify(row)}\n`), attached: value => process.send?.(value) });
    fs.fsyncSync(fd); if (!success) process.exitCode = 1;
  } finally { fs.closeSync(fd); }
} catch { process.stderr.write('Independent observer failed; retain public evidence.\n'); process.exitCode = 1; }
