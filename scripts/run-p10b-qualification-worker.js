import { createP10bControlChannel } from '../server/services/p10bControlChannel.js';
import { p10bRuntimeFailure } from '../server/services/p10bRuntimeFailure.js';

const channel = createP10bControlChannel({ input: process.stdin, output: process.stdout });
try {
  // Include dependency loading and default runtime configuration in the safe
  // bootstrap boundary; an uncaught import stack would otherwise reach SSH.
  const { serveP10bQualificationWorker } = await import('../server/services/p10bQualificationWorker.js');
  await serveP10bQualificationWorker({ channel });
} catch (error) {
  try { channel.send({ version: 'p10b-control-v1', kind: 'worker-failed',
    failureDetails: p10bRuntimeFailure('worker', 'bootstrap', error) }); await channel.flush(); }
  catch { /* The independent guardian still owns the frozen cutoff. */ }
  // A live SSH input keeps the JSON-lines reader active. Close that local
  // input after diagnostic flush so bootstrap failure actually exits code 1.
  process.stdin.destroy();
  process.stderr.write('Isolated qualification worker failed.\n'); process.exitCode = 1;
}
