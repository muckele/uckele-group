import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { installLoopbackGuard } from '../test-owner-flow/network-guard.js';

test('FL05 denies normalized external sockets and UNIX services before native connect', () => {
  const native = net.Socket.prototype.connect;
  const delegated = [];
  net.Socket.prototype.connect = function (...args) { delegated.push(args); return this; };
  const blocked = [];
  const restore = installLoopbackGuard(blocked);
  try {
    assert.throws(() => net.createConnection({ host: 'synthetic.external.invalid', port: 443 }), /denied/);
    assert.throws(() => net.createConnection(443, '203.0.113.1'), /denied/);
    assert.throws(() => net.createConnection({ path: '/tmp/existing-service.sock' }), /denied/);
    assert.throws(() => new net.Socket().connect({ port: 443 }), /denied/);
    assert.equal(delegated.length, 0);
    net.createConnection({ host: '127.0.0.1', port: 4173 });
    assert.equal(delegated.length, 1);
    assert.equal(blocked.length, 4);
  } finally { restore(); net.Socket.prototype.connect = native; }
});
