import fs from 'node:fs';
import { parseP10bGuestWindow } from '../server/services/p10bGuestShutdown.js';
import { runP10bGuardianParent } from '../server/services/p10bGuardianParent.js';

// The separately configured Fly process receives no application secrets.
try {
  if (process.argv.length !== 2) throw Error('No arguments admitted');
  const window = parseP10bGuestWindow(process.env.P10B_GUEST_WINDOW, {
    app: process.env.FLY_APP_NAME, machineId: process.env.FLY_MACHINE_ID,
    sourceHead: fs.readFileSync('/app/p10b-source-head.txt', 'utf8').trim(),
  });
  await runP10bGuardianParent({ window });
} catch {
  process.stderr.write('Guest guardian parent binding failed; no qualification admitted.\n');
  process.exit(1);
}
