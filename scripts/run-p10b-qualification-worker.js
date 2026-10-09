import { createP10bControlChannel } from '../server/services/p10bControlChannel.js';
import { serveP10bQualificationWorker } from '../server/services/p10bQualificationWorker.js';

const channel = createP10bControlChannel({ input: process.stdin, output: process.stdout });
try { await serveP10bQualificationWorker({ channel }); }
catch { process.stderr.write('Isolated qualification worker failed.\n'); process.exitCode = 1; }
