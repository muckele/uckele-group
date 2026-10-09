import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runP10bQualificationHost, validateP10bRuntimePacket } from '../server/services/p10bQualificationHost.js';
import { createP10bFlyControl } from '../server/services/p10bFlyControl.js';

// Invocation is explicit and has no startup registration. A future owner
// approval must bind this exact packet and command; merely importing it does
// not contact Fly or an email provider.
export async function runFirstMailboxCli(args, { adapter = createP10bFlyControl() } = {}) {
  if (args.length !== 4 || args[0] !== '--packet' || args[2] !== '--evidence-prefix') {
    throw new Error('Expected --packet FILE --evidence-prefix PATH');
  }
  const bytes = fs.readFileSync(path.resolve(args[1]));
  if (bytes.length > 65536) throw new Error('Runtime packet exceeds bound');
  const packet = JSON.parse(bytes);
  validateP10bRuntimePacket(packet, new Date().toISOString());
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const head = execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  if (head !== packet.sourceHead || dirty.trim()) throw new Error('Exact clean reviewed source is required');
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
