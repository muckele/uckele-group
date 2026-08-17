import 'dotenv/config';
import { getStorage } from '../server/storage/index.js';
import { auditDealHunterCrmIntegrity } from '../server/services/dealHunter.js';

async function main() {
  if (process.argv.includes('--apply')) {
    throw new Error('This command is intentionally read-only. Repair requires a separately reviewed manifest and verified backup.');
  }
  const audit = await auditDealHunterCrmIntegrity({ storage: getStorage() });
  console.log(JSON.stringify(audit, null, 2));
  if (!audit.ok) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`[deal-hunter-crm-integrity] ${error.message}`);
  process.exitCode = 1;
});
