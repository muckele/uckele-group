import { getConfig } from '../config.js';
import { createSqliteStorage } from './sqlite.js';
import { createSupabaseStorage } from './supabase.js';

let cachedStorage;

export function getStorage() {
  if (cachedStorage) {
    return cachedStorage;
  }

  const config = getConfig();
  cachedStorage =
    config.storage.provider === 'supabase' ? createSupabaseStorage(config) : createSqliteStorage(config);

  return cachedStorage;
}
