import fs from 'node:fs';
import path from 'node:path';
import { readP10bPublicJson, createP10bOperatorEvidence } from '../server/services/p10bOperatorFiles.js';
import { runP10bIndependentObserver } from '../server/services/p10bIndependentObserver.js';
import { assertP10bNoEmailApproval, assertP10bFrozenPhase } from '../server/services/p10bRuntimeOnlyOperator.js';
import { assertP10bNoEmailHostBinding } from '../server/services/p10bOperatorSource.js';
import { p10bInheritedAppTokenEnvironment } from '../server/services/p10bHostAuthentication.js';
import { createP10bParentLease } from '../server/services/p10bParentLease.js';

// Separate OS session, own read-only native connection, own log stream. Only
// sanitized lifecycle records are published to this exclusive public file.
let lease;
try {
  if (process.argv.length !== 4) throw Error();
  lease = createP10bParentLease();
  const input = readP10bPublicJson(process.argv[2]);
  assertP10bNoEmailApproval(input.session, input.approval, Date.now()); assertP10bFrozenPhase(input.session, input.phase);
  assertP10bNoEmailHostBinding(input.session);
  const evidence = createP10bOperatorEvidence(path.dirname(path.resolve(process.argv[2])));
  if (evidence.has('SESSION_NOT_APPROVED') || evidence.has('p10b-runtime-only-session-closure.json')) throw Error();
  if (path.dirname(path.resolve(process.argv[3])) !== evidence.root) throw Error();
  const fd = fs.openSync(process.argv[3], 'wx', 0o600);
  try {
    const environment = p10bInheritedAppTokenEnvironment(input);
    lease.assertActive();
    const success = await runP10bIndependentObserver({ ...input, environment, signal: lease.signal,
      record: row => fs.writeSync(fd, `${JSON.stringify(row)}\n`), async attached(value) {
        lease.assertActive(); let timer;
        try {
          await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error('Observer attachment IPC timed out')), 500);
            process.send(value, error => error ? reject(Error('Observer attachment IPC failed')) : resolve());
          });
          lease.assertActive();
        } finally { clearTimeout(timer); }
      } });
    fs.fsyncSync(fd); if (!success) process.exitCode = 1;
  } finally { fs.closeSync(fd); }
} catch { process.stderr.write('Independent observer failed; retain public evidence.\n'); process.exitCode = 1; }
finally { lease?.close(); }
