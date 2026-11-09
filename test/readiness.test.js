import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkReadiness } from '../server/services/readiness.js';

test('failed readiness checks log only the check name and error code, never paths or messages', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (line) => warnings.push(line));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const regularFile = path.join(directory, 'not-a-directory');
  fs.writeFileSync(regularFile, '');
  const storage = {
    async checkHealth() {
      throw Object.assign(new Error(`locked ${directory}/owner@example.test`), { code: 'SQLITE_BUSY' });
    },
  };

  const result = await checkReadiness({
    config: { secureDocuments: { storageDir: path.join(regularFile, 'vault') } }, storage,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks, {
    configuration: 'ok', storage: 'failed', cimStage2Storage: 'failed', documentVault: 'failed',
  });
  assert.deepEqual(warnings, [
    '[ready] check failed check=storage code=SQLITE_BUSY',
    '[ready] check failed check=documentVault code=ENOTDIR',
  ]);
});

test('a failure with no error code logs unknown, and a long code is cut short', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (line) => warnings.push(line));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { secureDocuments: { storageDir: path.join(directory, 'vault') } };

  await checkReadiness({ config, storage: { async checkHealth() { throw new Error('no code'); } } });
  await checkReadiness({ config, storage: { async checkHealth() {
    throw Object.assign(new Error('long'), { code: 'X'.repeat(100) });
  } } });

  assert.deepEqual(warnings, [
    '[ready] check failed check=storage code=unknown',
    `[ready] check failed check=storage code=${'X'.repeat(40)}`,
  ]);
});
