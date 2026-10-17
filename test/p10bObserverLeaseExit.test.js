import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = new URL('../scripts/run-p10b-independent-observer.js', import.meta.url);

// Exercise the unchanged CLI with real IPC, timers and file descriptors. Only
// admission/authentication and the observer transport loop are synthetic here;
// the separate observer tests exercise that loop's timing and proof policy.
async function fixture(mode, directory) {
  const input = path.join(directory, 'synthetic-input.json');
  const output = path.join(directory, 'observer.jsonl');
  process.argv = [process.execPath, fileURLToPath(cli), input, output];
  const modules = {
    'node:fs': { default: fs },
    'node:path': { default: path },
    'p10bOperatorFiles.js': { readP10bPublicJson: () => ({ session: {}, approval: {} }),
      createP10bOperatorEvidence: () => ({ root: directory, has: () => false }) },
    'p10bRuntimeOnlyOperator.js': { assertP10bNoEmailApproval() {}, assertP10bFrozenPhase() {} },
    'p10bOperatorSource.js': { assertP10bNoEmailHostBinding() {} },
    'p10bHostAuthentication.js': { p10bInheritedAppTokenEnvironment: () => ({}) },
    'p10bParentLease.js': await import('../server/services/p10bParentLease.js'),
    'p10bIndependentObserver.js': { async runP10bIndependentObserver({ attached, signal, record }) {
      try {
        await attached({ fixtureAttached: true });
        if (mode === 'disconnect' || mode === 'signal') {
          await new Promise(resolve => {
            if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
          });
        }
        return mode === 'success';
      } finally { record({ syntheticCleanupComplete: true, aborted: signal.aborted }); }
    } },
  };
  const context = vm.createContext({ process, setTimeout, clearTimeout });
  const source = new vm.SourceTextModule(fs.readFileSync(cli, 'utf8'), { context, identifier: cli.href });
  await source.link(specifier => {
    const exports = modules[specifier.startsWith('node:') ? specifier : path.basename(specifier)];
    if (!exports) throw Error('Unexpected observer fixture boundary');
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await source.evaluate();
}

function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Observer CLI did not exit naturally')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

if (process.argv[2] === 'observer-lease-fixture') {
  await fixture(process.argv[3], process.argv[4]);
} else {
  for (const mode of ['success', 'failure', 'disconnect', 'signal']) {
    test(`real observer CLI ${mode} releases its IPC lease after local cleanup`, { timeout: 5000 }, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p10b-observer-exit-'));
      const child = spawn(process.execPath, ['--experimental-vm-modules', '--no-warnings',
        fileURLToPath(import.meta.url), 'observer-lease-fixture', mode, directory], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; assert.ok(stdout.length < 1024); });
      child.stderr.on('data', chunk => { stderr += chunk; assert.ok(stderr.length < 1024); });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      const drained = Promise.all([new Promise(resolve => child.stdout.once('end', resolve)),
        new Promise(resolve => child.stderr.once('end', resolve))]);
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          process.kill(-child.pid, 'SIGKILL'); await bounded(exited, 1500);
        }
        if (child.connected) child.disconnect();
        fs.rmSync(directory, { recursive: true, force: true });
      });
      assert.deepEqual(await bounded(new Promise(resolve => child.once('message', resolve)), 2000), { fixtureAttached: true });
      assert.equal(child.connected, true);
      if (mode === 'disconnect') child.disconnect();
      if (mode === 'signal') child.kill('SIGTERM');
      const [terminal] = await bounded(Promise.all([exited, drained]), 2000);
      assert.deepEqual(terminal, { code: mode === 'success' ? 0 : 1, signal: null });
      assert.equal(stdout, ''); assert.equal(stderr, '');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'observer.jsonl'), 'utf8')),
        { syntheticCleanupComplete: true, aborted: mode === 'disconnect' || mode === 'signal' });
      assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
    });
  }
}
