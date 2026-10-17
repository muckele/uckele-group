import fs from 'node:fs';
import { parseP10bGuestWindow } from '../server/services/p10bGuestShutdown.js';
import { runP10bGuestGuardian } from '../server/services/p10bGuestGuardian.js';

// The secret-free Fly-configured parent starts this guardian at boot. It
// reads only public runtime binding and the image's nonsecret source marker.
try {
  if (process.argv.length !== 2) throw new Error('No arguments admitted');
  const window = parseP10bGuestWindow(process.env.P10B_GUEST_WINDOW, {
    app: process.env.FLY_APP_NAME, machineId: process.env.FLY_MACHINE_ID,
    sourceHead: fs.readFileSync('/app/p10b-source-head.txt', 'utf8').trim(),
  });
  await runP10bGuestGuardian({ window });
} catch {
  process.stderr.write('Guest shutdown binding failed; no qualification admitted.\n');
  process.exit(0);
}
