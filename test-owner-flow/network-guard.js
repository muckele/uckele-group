import net from 'node:net';

export function installLoopbackGuard(blocked) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.createConnection passes its normalized [options, callback] tuple;
    // direct Socket.connect callers may instead pass options or port/host.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === 'object' ? first
      : typeof first === 'number' ? { port: first, host: args[1] } : null;
    if (!options || options.path || !['127.0.0.1', '::1'].includes(options.host)
      || !Number.isInteger(Number(options.port)) || Number(options.port) < 1 || Number(options.port) > 65535) {
      blocked.push('non-loopback-socket');
      throw new Error('FL05 external network and UNIX services denied');
    }
    return connect.apply(this, args);
  };
  return () => { net.Socket.prototype.connect = connect; };
}
