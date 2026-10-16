import { p10bStoppedUpdateReport, P10bStoppedUpdateCliHold } from '../server/services/p10bStoppedUpdateReport.js';
import { runP10bStoppedUpdateCli } from '../server/services/p10bStoppedUpdateCli.js';
try {
  const result = await runP10bStoppedUpdateCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.success !== true) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ success: false, operatorReport: error instanceof P10bStoppedUpdateCliHold
    ? error.operatorReport : p10bStoppedUpdateReport() })}\n`);
  process.exitCode = 1;
}
