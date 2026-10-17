import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runP10bQualificationHost, validateP10bRuntimePacket } from '../server/services/p10bQualificationHost.js';
import { createP10bFlyControl } from '../server/services/p10bFlyControl.js';
import { assertP10bReviewedCheckout, assertP10bPreparationHostSource } from '../server/services/p10bOperatorSource.js';

// Invocation is explicit and has no startup registration. A future owner
// approval must bind this exact packet and command; merely importing it does
// not contact Fly or an email provider.
export async function runFirstMailboxCli(args, { adapter, hostSession, hostApproval, hostPhase } = {}) {
  if (args.length !== 4 || args[0] !== '--packet' || args[2] !== '--evidence-prefix') {
    throw new Error('Expected --packet FILE --evidence-prefix PATH');
  }
  const bytes = fs.readFileSync(path.resolve(args[1]));
  if (bytes.length > 65536) throw new Error('Runtime packet exceeds bound');
  const packet = JSON.parse(bytes);
  validateP10bRuntimePacket(packet, new Date().toISOString());
  if (hostSession || hostApproval || hostPhase) assertP10bPreparationHostSource({ session: hostSession, approval: hostApproval,
    phase: hostPhase, packet });
  else assertP10bReviewedCheckout(packet.sourceHead);
  adapter ||= createP10bFlyControl();
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try { return await runP10bQualificationHost({ packet, adapter, evidencePath: path.resolve(args[3]),
    signal: cancellation.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runFirstMailboxCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.success) process.exitCode = 1;
  } catch { process.stderr.write('Isolated first-mailbox operation failed; retain evidence.\n'); process.exitCode = 1; }
}
