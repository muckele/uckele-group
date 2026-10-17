// Bounded JSON lines over the existing authenticated SSH stdio channel. No
// listener, credential forwarding, shell interpolation or new network service.
export function createP10bControlChannel({ input, output }) {
  let buffer = Buffer.alloc(0);
  let count = 0;
  let receivedBytes = 0;
  let sentBytes = 0;
  let ended = false;
  let failure;
  const queue = [];
  const waiters = [];
  const finish = (error) => {
    if (ended) return;
    ended = true;
    failure = error;
    if (error) queue.length = 0;
    for (const { resolve, reject } of waiters.splice(0)) error ? reject(error) : resolve(null);
  };
  input.on('data', (chunk) => {
    if (ended) return;
    receivedBytes += chunk.length;
    if (buffer.length + chunk.length > 65536 || receivedBytes > 4 * 1024 * 1024) return finish(new Error('Control frame exceeded bound'));
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.includes(10)) {
      const offset = buffer.indexOf(10);
      const line = buffer.subarray(0, offset);
      buffer = buffer.subarray(offset + 1);
      try {
        const frame = JSON.parse(line.toString('utf8'));
        if (++count > 4096 || !frame || Array.isArray(frame) || frame.version !== 'p10b-control-v1'
          || typeof frame.kind !== 'string') throw new Error('Invalid control frame');
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(frame);
        else {
          if (queue.length >= 16) throw new Error('Control queue exceeded bound');
          queue.push(frame);
        }
      } catch { finish(new Error('Invalid control stream')); return; }
    }
  });
  input.on('error', () => finish(new Error('Control stream failed')));
  input.on('end', () => finish(buffer.length ? new Error('Incomplete control frame') : null));
  input.on('close', () => finish(buffer.length ? new Error('Incomplete control frame') : null));
  output.on('error', () => finish(new Error('Control stream failed')));
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return failure ? Promise.reject(failure) : Promise.resolve(null);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    send(frame) {
      if (ended || !frame || frame.version !== 'p10b-control-v1') throw new Error('Control channel unavailable');
      const line = Buffer.from(`${JSON.stringify(frame)}\n`);
      sentBytes += line.length;
      if (line.length > 65536 || sentBytes > 4 * 1024 * 1024 || output.writableLength > 65536) throw new Error('Control frame exceeded bound');
      output.write(line);
    },
    flush() {
      if (ended) return Promise.reject(new Error('Control channel unavailable'));
      return new Promise((resolve, reject) => output.write('', (error) => error ? reject(error) : resolve()));
    },
    close(error = new Error('Control channel closed')) { finish(error); },
  };
}
