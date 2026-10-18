import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertP10bGuestReady, parseP10bGuestWindow, p10bGuestPaths, readP10bGuestRecord,
  p10bGuestFreshPathInventory } from '../server/services/p10bGuestShutdown.js';

// The SSH command reads only public window/source markers and file presence.
// It does not import configuration, storage, or provider code.
export async function readP10bPublicReadiness({ environment = process.env, sourceHead,
  filesystem = fs, signalProcess = process.kill } = {}) {
  sourceHead ||= filesystem.readFileSync('/app/p10b-source-head.txt', 'utf8').trim();
  const window = parseP10bGuestWindow(environment.P10B_GUEST_WINDOW, {
    app: environment.FLY_APP_NAME, machineId: environment.FLY_MACHINE_ID, sourceHead });
  await assertP10bGuestReady({ window, signalProcess });
  const other = window.databasePath.replace('-watchdog-', '-nosend-');
  if (other === window.databasePath) throw Error('Demonstration path required');
  const inventory = p10bGuestFreshPathInventory([window.databasePath, other], {
    activeDatabasePath: window.databasePath, activePhase: window.phase });
  if (inventory.some(file => filesystem.existsSync(file))) throw Error('Fresh paths required');
  const p = p10bGuestPaths(window);
  return { sourceHead, guardianAlive: true, parentAlive: true, freshPathsVerified: true,
    guardianReady: readP10bGuestRecord(p.ready), guardianStart: readP10bGuestRecord(p.start),
    guardianParentStart: readP10bGuestRecord(p.parentStart) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 2) throw Error(); process.stdout.write(`${JSON.stringify(await readP10bPublicReadiness())}\n`); }
  catch { process.stderr.write('Public guest readiness failed.\n'); process.exitCode = 1; }
}
