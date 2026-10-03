import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function loadHealthcheck() {
  try {
    return await import('../scripts/check-cim-scan-worker-health.js');
  } catch {
    return {};
  }
}

async function listen(socketPath, response) {
  const requests = [];
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(0)) {
        requests.push(Buffer.concat(chunks));
        if (response !== null) socket.end(response);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { server, requests };
}

test('ClamD healthcheck accepts only exact PONG from a stable Unix socket', async (t) => {
  const { checkClamavUnixSocketHealth } = await loadHealthcheck();
  assert.equal(
    typeof checkClamavUnixSocketHealth,
    'function',
    'scanner package must provide a Unix-socket healthcheck',
  );
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ug-clamd-health-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const healthyPath = path.join(root, 'healthy.sock');
  const healthy = await listen(healthyPath, Buffer.from('PONG\0'));
  t.after(() => new Promise((resolve) => healthy.server.close(resolve)));
  await checkClamavUnixSocketHealth({ socketPath: healthyPath, timeoutMs: 500 });
  assert.deepEqual(healthy.requests, [Buffer.from('zPING\0')]);

  const wrongPath = path.join(root, 'wrong.sock');
  const wrong = await listen(wrongPath, Buffer.from('NOT-PONG\0'));
  t.after(() => new Promise((resolve) => wrong.server.close(resolve)));
  await assert.rejects(
    checkClamavUnixSocketHealth({ socketPath: wrongPath, timeoutMs: 500 }),
    /response|PONG/i,
  );

  const regularFile = path.join(root, 'not-a-socket');
  await fsp.writeFile(regularFile, 'PONG');
  await assert.rejects(
    checkClamavUnixSocketHealth({ socketPath: regularFile, timeoutMs: 500 }),
    /socket/i,
  );

  const stalledPath = path.join(root, 'stalled.sock');
  const stalled = await listen(stalledPath, null);
  t.after(() => new Promise((resolve) => stalled.server.close(resolve)));
  await assert.rejects(
    checkClamavUnixSocketHealth({ socketPath: stalledPath, timeoutMs: 25 }),
    /deadline/i,
  );

  const replacedPath = path.join(root, 'replaced.sock');
  const replaced = await listen(replacedPath, Buffer.from('PONG\0'));
  t.after(() => new Promise((resolve) => replaced.server.close(resolve)));
  let lstatCalls = 0;
  const replaceIdentityOnConnect = async (candidate) => {
    const stat = await fsp.lstat(candidate);
    lstatCalls += 1;
    if (lstatCalls !== 2) return stat;
    return {
      dev: stat.dev,
      ino: stat.ino + 1,
      isSocket: () => true,
      isSymbolicLink: () => false,
    };
  };
  await assert.rejects(
    checkClamavUnixSocketHealth({
      socketPath: replacedPath,
      timeoutMs: 500,
      lstat: replaceIdentityOnConnect,
    }),
    /identity/i,
  );
});

test('scanner package replaces inherited TCP healthcheck with bounded Unix-socket readiness', async () => {
  const dockerfile = await fsp.readFile('containers/cim-scan-worker/Containerfile', 'utf8');
  const clamConfig = await fsp.readFile('containers/cim-scan-worker/clamd.conf', 'utf8');
  const entrypoint = await fsp.readFile('containers/cim-scan-worker/entrypoint.sh', 'utf8');

  assert.match(
    dockerfile,
    /^COPY scripts\/check-cim-scan-worker-health\.js \/opt\/uckele\/scripts\/check-cim-scan-worker-health\.js$/m,
  );
  assert.match(
    dockerfile,
    /^HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --start-interval=1s --retries=3 CMD \["node", "scripts\/check-cim-scan-worker-health\.js"\]$/m,
  );
  assert.doesNotMatch(dockerfile, /clamdcheck\.sh|localhost|3310/);
  assert.match(clamConfig, /^LocalSocket \/run\/clamav\/clamd\.sock$/m);
  assert.doesNotMatch(clamConfig, /^\s*(?:TCPAddr|TCPSocket)\b/m);

  const readiness = entrypoint.indexOf('node scripts/check-cim-scan-worker-health.js');
  const dwell = entrypoint.indexOf('sleep 4', readiness);
  const worker = entrypoint.indexOf('node scripts/run-cim-scan-worker.js', dwell);
  assert.ok(readiness >= 0, 'entrypoint must prove ClamD readiness before scanning');
  assert.ok(dwell > readiness, 'entrypoint must allow Docker health to observe readiness');
  assert.ok(worker > dwell, 'one-shot scan must start only after the bounded readiness dwell');
});
