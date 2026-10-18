import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { observeOwnedBrowserSpawn, stopOwnedProcessGroup } from '../scripts/fl05-owned-process.js';

test('FL05 records ownership before launch readiness and bounds an unresponsive process group', { timeout: 5000 }, async (t) => {
  let ownedPid;
  const restore = observeOwnedBrowserSpawn(process.execPath, (pid) => { ownedPid = pid; });
  t.after(restore);
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {
    detached: true, env: {}, stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(ownedPid, child.pid, 'Ownership is synchronous, before delayed readiness/registration');
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { assert.equal(error.code, 'ESRCH'); }
  });
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  const result = await stopOwnedProcessGroup(child.pid, { graceMs: 50, killWaitMs: 1000 });
  assert.equal(result.absent, true);
  assert.equal((await exited)[1], 'SIGKILL');
  assert.deepEqual(await stopOwnedProcessGroup(child.pid), { absent: true });
});

test('FL05 contains a browser registration write failure before losing spawn ownership', { timeout: 5000 }, async (t) => {
  let pid;
  const dispose = observeOwnedBrowserSpawn(process.execPath, (ownedPid) => {
    pid = ownedPid;
    throw new Error('synthetic registration publication failed');
  });
  t.after(async () => {
    if (pid) await stopOwnedProcessGroup(pid);
    await dispose().catch(() => {});
  });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true, env: {}, stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  await assert.rejects(dispose(), /registration publication failed/);
  assert.equal((await exited)[1], 'SIGKILL');
  assert.deepEqual(await stopOwnedProcessGroup(pid), { absent: true });
});
