import { createSqliteStorage } from '../../server/storage/sqlite.js';

const [sqlitePath, operation, serializedInput] = process.argv.slice(2);
const storage = createSqliteStorage({
  storage: { sqlitePath },
  protection: { rateLimitRetentionMs: 0 },
});
const input = JSON.parse(serializedInput);

function finish(message, exitCode = 0) {
  process.send(message, () => {
    storage.close();
    process.disconnect();
    process.exit(exitCode);
  });
}

process.on('message', (message) => {
  if (message !== 'go') return;
  process.send({ phase: 'attempting', operation }, async (sendError) => {
    if (sendError) {
      finish({ phase: 'error', operation, error: sendError.message }, 1);
      return;
    }
    try {
      const result = await storage[operation](input);
      finish({ phase: 'result', operation, result });
    } catch (error) {
      finish({ phase: 'error', operation, error: error?.stack || error?.message || String(error) }, 1);
    }
  });
});

process.send({ phase: 'ready', operation });
