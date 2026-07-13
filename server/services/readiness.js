import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { getConfig } from '../config.js';
import { getStorage } from '../storage/index.js';

async function checkDocumentVault(config) {
  await fs.mkdir(config.secureDocuments.storageDir, { recursive: true });
  await fs.access(config.secureDocuments.storageDir, fsConstants.R_OK | fsConstants.W_OK);
}

export async function checkReadiness() {
  const config = getConfig();
  const checks = {
    configuration: 'ok',
    storage: 'ok',
    documentVault: 'ok',
  };

  try {
    const storage = getStorage();
    if (storage.checkHealth) {
      await storage.checkHealth();
    } else {
      await storage.getSummary();
    }
  } catch {
    checks.storage = 'failed';
  }

  try {
    await checkDocumentVault(config);
  } catch {
    checks.documentVault = 'failed';
  }

  return {
    ok: Object.values(checks).every((status) => status === 'ok'),
    checks,
  };
}
