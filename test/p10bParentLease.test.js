import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

test('parent lease latches disconnect and termination once and denies later work', async () => {
  const { createP10bParentLease } = await import('../server/services/p10bParentLease.js');
  const owner = Object.assign(new EventEmitter(), { connected: true, send() {} }); let losses = 0;
  const lease = createP10bParentLease({ owner, onLoss: async () => { losses++; } });
  lease.assertActive(); owner.connected = false; owner.emit('disconnect'); owner.emit('SIGTERM');
  await Promise.resolve(); assert.equal(losses, 1); assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertActive(), /Parent lease lost/); lease.close();
});

test('missing parent IPC is refused before setup', async () => {
  const { createP10bParentLease } = await import('../server/services/p10bParentLease.js');
  assert.throws(() => createP10bParentLease({ owner: new EventEmitter() }), /Parent IPC required/);
});
