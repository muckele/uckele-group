import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';

async function checkDocumentVault(config) {
  await fs.mkdir(config.secureDocuments.storageDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.secureDocuments.storageDir, 0o700);
  await fs.access(config.secureDocuments.storageDir, fsConstants.R_OK | fsConstants.W_OK);
}

// The error code only (SQLITE_BUSY, ENOSPC): messages can carry paths, and the response stays unchanged.
function logCheckError(check, error) {
  console.warn(`[ready] check failed check=${check} code=${String(error?.code || 'unknown').slice(0, 40)}`);
}

export async function checkReadiness({ config = getConfig(), storage: injectedStorage } = {}) {
  const checks = {
    configuration: 'ok',
    storage: 'ok',
    cimStage2Storage: 'ok',
    documentVault: 'ok',
  };

  try {
    const storage = injectedStorage || getStorage();
    if (storage.checkHealth) {
      await storage.checkHealth();
    } else {
      await storage.getSummary();
    }
    const stage2Storage = await storage.checkCimStage2Storage?.();
    if (!stage2Storage?.ok) checks.cimStage2Storage = 'failed';
  } catch (error) {
    logCheckError('storage', error);
    checks.storage = 'failed';
    checks.cimStage2Storage = 'failed';
  }

  try {
    await checkDocumentVault(config);
  } catch (error) {
    logCheckError('documentVault', error);
    checks.documentVault = 'failed';
  }

  return {
    ok: Object.values(checks).every((status) => status === 'ok'),
    checks,
  };
}
