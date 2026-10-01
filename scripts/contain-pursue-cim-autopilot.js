import 'dotenv/config';
import { getStorage } from '../server/storage/index.js';
import { runPursueCimAutomaticContainment } from '../server/services/pursueCimOperations.js';

async function main() {
  const storage = getStorage();
  try {
    const result = await runPursueCimAutomaticContainment({ storage,
      actor: 'p9-automatic-containment' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    storage.close?.();
  }
}

main().catch((error) => {
  process.stderr.write(`[pursue-cim-containment] ${error.message}\n`);
  process.exitCode = 1;
});
