import 'dotenv/config';
import path from 'node:path';
import { getConfig } from '../server/config.js';
import { getStorage } from '../server/storage/index.js';
import {
  createBackupBundle,
  listBackupBundles,
  restoreBackupBundle,
  verifyBackupBundle,
} from '../server/services/backups.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

async function resolveBundle(config) {
  const explicit = option('--bundle');
  if (explicit) return path.resolve(explicit);
  const [latest] = await listBackupBundles(config);
  if (!latest) throw new Error(`No backup bundle exists in ${config.backup.directory}.`);
  return latest.path;
}

async function main() {
  const config = getConfig();
  const command = process.argv[2] || '';

  if (command === 'create') {
    const backup = await createBackupBundle({ storage: getStorage(), config });
    console.log(JSON.stringify({ ok: true, path: backup.path, manifest: backup.manifest }, null, 2));
    return;
  }

  if (command === 'verify') {
    const result = await verifyBackupBundle(await resolveBundle(config));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'restore') {
    const bundle = await resolveBundle(config);
    const databasePath = path.resolve(option('--database') || config.storage.sqlitePath);
    const documentsDirectory = path.resolve(option('--documents') || config.secureDocuments.storageDir);
    const restoringLive = databasePath === path.resolve(config.storage.sqlitePath) || documentsDirectory === path.resolve(config.secureDocuments.storageDir);
    if (restoringLive && !process.argv.includes('--confirm-live')) {
      throw new Error('Live restore refused. Stop the application, confirm the bundle, and pass --confirm-live. For a drill, provide temporary --database and --documents destinations.');
    }
    const result = await restoreBackupBundle(bundle, {
      databasePath,
      documentsDirectory,
      overwrite: process.argv.includes('--overwrite') || restoringLive,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error('Usage: npm run backup:create | npm run backup:verify -- [--bundle PATH] | npm run backup:restore -- [--bundle PATH] [--database PATH] [--documents PATH] [--overwrite] [--confirm-live]');
}

main().catch((error) => {
  console.error(`[backup] ${error.message}`);
  process.exitCode = 1;
});
