import { runP10bNoEmailSessionCli } from '../server/services/p10bNoEmailSessionCli.js';
try { process.stdout.write(`${JSON.stringify(await runP10bNoEmailSessionCli(process.argv.slice(2)), null, 2)}\n`); }
catch { process.stderr.write('No-email session failed or held; preserve evidence.\n'); process.exitCode = 1; }
