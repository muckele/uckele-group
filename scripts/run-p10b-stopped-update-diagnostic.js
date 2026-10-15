import { runP10bStoppedUpdateCli } from '../server/services/p10bStoppedUpdateCli.js';
try {
  const result = await runP10bStoppedUpdateCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.success !== true) process.exitCode = 1;
} catch { process.stderr.write('Stopped-update diagnostic failed or held; preserve evidence.\n'); process.exitCode = 1; }
