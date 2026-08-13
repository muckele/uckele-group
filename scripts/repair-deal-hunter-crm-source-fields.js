import 'dotenv/config';
import path from 'node:path';
import { getStorage } from '../server/storage/index.js';
import { verifyBackupBundle } from '../server/services/backups.js';
import { repairDealHunterCrmSourceFields } from '../server/services/dealHunter.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirmation = option('--confirm');
  const actor = option('--actor');
  const submissionId = option('--submission-id');
  const backupReference = option('--backup');
  const resolvedBackupReference = backupReference ? path.resolve(backupReference) : '';
  let backupVerified = false;

  if (!submissionId) {
    throw new Error('Provide --submission-id ID.');
  }
  if (apply && confirmation !== 'APPLY-DEAL-HUNTER-CRM-SOURCE-REPAIR') {
    throw new Error('Apply requires --confirm APPLY-DEAL-HUNTER-CRM-SOURCE-REPAIR.');
  }
  if (apply && !actor) {
    throw new Error('Apply requires --actor NAME.');
  }
  if (apply && !backupReference) {
    throw new Error('Apply requires --backup PATH.');
  }
  if (apply) {
    const verification = await verifyBackupBundle(resolvedBackupReference);
    if (!verification.ok) {
      throw new Error(`Backup verification failed: ${verification.errors.slice(0, 3).join('; ')}`);
    }
    backupVerified = true;
  }

  const result = await repairDealHunterCrmSourceFields({
    submissionId,
    apply,
    actor,
    backupVerified,
    backupReference: resolvedBackupReference,
    storage: getStorage(),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`[deal-hunter-crm-source-repair] ${error.message}`);
  process.exitCode = 1;
});
