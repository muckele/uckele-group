import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createP10bFlyControl } from '../server/services/p10bFlyControl.js';
import { sha256 } from '../server/utils/security.js';

test('no-email inventory uses a bound names-exclusive client and never the secrets-list CLI', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-names-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'client'); fs.writeFileSync(executable, 'offline binding');
  const adapter = createP10bFlyControl({ secretNamesExecutable: executable,
    secretNamesSha256: sha256(fs.readFileSync(executable)), environment: { PATH: '/usr/bin:/bin', HOME: root },
    spawnProcess: (binary, args, options) => {
      assert.equal(binary, executable); assert.deepEqual(args, ['--secret-names']);
      return spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(["B_KEY","A_KEY"]))'], options);
    } });
  assert.equal(typeof adapter.getSecretNames, 'function');
  assert.deepEqual(await adapter.getSecretNames({ app: 'uckele-group-p10b' }), ['A_KEY', 'B_KEY']);
  assert.equal(await adapter.reap(), true);
});

test('names-only admission refuses malformed, duplicate, forbidden or digest-bearing output', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-names-deny-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'client'); fs.writeFileSync(file, 'fixture');
  for (const value of [[{ name: 'A_KEY', digest: 'abc123' }], ['A_KEY', 'A_KEY'], ['RESEND_API_KEY'], ['invalid-name'], Array(33).fill('A_KEY')]) {
    const adapter = createP10bFlyControl({ secretNamesExecutable: file, secretNamesSha256: sha256('fixture'),
      environment: { PATH: '/usr/bin:/bin', HOME: root },
      spawnProcess: (_binary, _args, options) => spawn(process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`], options) });
    assert.equal(typeof adapter.getSecretNames, 'function');
    await assert.rejects(adapter.getSecretNames({ app: 'uckele-group-p10b' }));
    assert.equal(await adapter.reap(), true);
  }
});

test('changed names-client binding or another app denies before spawning', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-names-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'client'); fs.writeFileSync(file, 'changed'); let calls = 0;
  const adapter = createP10bFlyControl({ secretNamesExecutable: file, secretNamesSha256: sha256('original'),
    spawnProcess: () => { calls++; throw Error('must not spawn'); } });
  assert.equal(typeof adapter.getSecretNames, 'function');
  await assert.rejects(adapter.getSecretNames({ app: 'uckele-group-p10b' }));
  await assert.rejects(adapter.getSecretNames({ app: 'uckele-group' }));
  assert.equal(calls, 0);
});
