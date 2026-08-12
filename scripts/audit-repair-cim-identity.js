import 'dotenv/config';
import path from 'node:path';
import { getStorage } from '../server/storage/index.js';
import { verifyBackupBundle } from '../server/services/backups.js';
import { runCimIdentityRepair } from '../server/services/cimIdentityRepair.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const backupReference = option('--backup');
  const storage = getStorage();
  let backupVerified = false;
  if (apply) {
    if (storage.provider !== 'sqlite') {
      throw new Error('CLI apply is limited to SQLite backups. Use the approved Supabase managed-backup repair runbook for remote storage.');
    }
    if (!backupReference) throw new Error('Apply requires --backup PATH. Dry-run is the default.');
    const verification = await verifyBackupBundle(path.resolve(backupReference));
    if (!verification.ok) throw new Error(`Backup verification failed: ${verification.errors.slice(0, 3).join('; ')}`);
    backupVerified = true;
  }
  const result = await runCimIdentityRepair({
    apply,
    confirmation: option('--confirm'),
    backupReference: apply ? path.resolve(backupReference) : '',
    backupVerified,
    actor: option('--actor') || (apply ? '' : 'cim-identity-audit'),
    storage,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`[cim-identity-repair] ${error.message}`);
  process.exitCode = 1;
});
