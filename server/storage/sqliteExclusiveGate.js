// An exclusive section on the single SQLite connection that still lets the event loop turn.
//
// better-sqlite3 runs a transaction synchronously, so a transaction that takes seconds freezes
// the whole server. Some transactions cannot be split without changing what readers can see
// (the complete-Sheet snapshot replacement rewrites every current observation and its safety
// events together). Such a transaction instead runs inside `runExclusive`: it begins its own
// transaction and returns to the event loop between steps, while every other storage call
// waits in a FIFO queue until the section ends. Health checks and timers keep running, and no
// other caller can read the half-written transaction or have its write folded into it.
//
// Rules the gate enforces:
// - With no section held, a storage call runs exactly as before: synchronously, returning
//   whatever the method returns. Only calls made while a section is held get a promise.
// - A section starts only when no storage call that awaits inside itself (a backup, for
//   example) is still running, so nothing resumes on the connection mid-section. Calls made
//   while a section is waiting to start still run, so a running call never waits on the
//   section it is blocking.
// - Sections run one at a time, in order.
// - The read-only health checks bypass the queue: they read through an open section, which
//   is harmless for `SELECT 1` and a schema check, and keeps `/api/ready` answering.
// - `close()` during a section rolls the section back at its next yield, then closes.

export const exclusiveGateBypassMethods = Object.freeze([
  'checkHealth',
  'checkCimStage2Storage',
  'getCrmDuplicateConsolidationConfigAuthority',
]);

export class StorageClosingError extends Error {
  constructor() {
    super('The storage connection closed during an exclusive section.');
    this.name = 'StorageClosingError';
  }
}

/**
 * Wraps every method of `storageApi` in place and returns `runExclusive`.
 *
 * `exclusiveMethods` names the methods that open a section themselves; they still queue while
 * another section is held, but are not counted as running calls (a section must not wait for
 * the call that is opening it).
 */
export function installSqliteExclusiveGate(storageApi, database, {
  exclusiveMethods = [],
  bypassMethods = exclusiveGateBypassMethods,
  logger = console,
  now = () => performance.now(),
} = {}) {
  const bypass = new Set(bypassMethods);
  const exclusive = new Set(exclusiveMethods);
  const queue = [];
  let held = false;
  let closeRequested = false;
  let closeOnRelease = null;
  let running = 0;
  let idleWaiters = [];
  let sectionChain = Promise.resolve();

  const settle = () => {
    running -= 1;
    if (running === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
  const invoke = (name, raw, self, args) => {
    const result = raw.apply(self, args);
    if (!exclusive.has(name) && result && typeof result.then === 'function') {
      running += 1;
      result.then(settle, settle);
    }
    return result;
  };

  for (const [name, raw] of Object.entries(storageApi)) {
    if (typeof raw !== 'function' || bypass.has(name)) continue;
    if (name === 'close') {
      storageApi.close = function closeStorage(...args) {
        if (!held) return raw.apply(this, args);
        closeRequested = true;
        closeOnRelease = () => raw.apply(this, args);
        return undefined;
      };
      continue;
    }
    storageApi[name] = function gatedStorageMethod(...args) {
      if (!held) return invoke(name, raw, this, args);
      return new Promise((resolve, reject) => {
        queue.push({ run: () => invoke(name, raw, this, args), resolve, reject, queuedAt: now() });
      });
    };
  }

  function drain() {
    const pending = queue.splice(0);
    for (const item of pending) {
      try {
        item.resolve(item.run());
      } catch (error) {
        item.reject(error);
      }
    }
  }

  /**
   * Runs `body({ checkpoint })` with every other storage call queued. `body` may await;
   * `checkpoint()` throws StorageClosingError once `close()` has been requested, and should be
   * called after each yield. Resolves or rejects with `body`'s outcome.
   */
  async function runExclusive(label, body) {
    const previous = sectionChain;
    let releaseSection;
    sectionChain = new Promise((resolve) => {
      releaseSection = resolve;
    });
    const requestedAt = now();
    let acquiredAt = requestedAt;
    let longestQueuedMs = 0;
    let queuedCalls = 0;
    try {
      await previous;
      while (running > 0) await new Promise((resolve) => idleWaiters.push(resolve));
      if (database.inTransaction) throw new Error('An exclusive storage section cannot start inside a transaction.');
      held = true;
      acquiredAt = now();
      return await body({
        checkpoint() {
          if (closeRequested) throw new StorageClosingError();
        },
      });
    } finally {
      if (held) {
        if (database.inTransaction) database.exec('ROLLBACK');
        held = false;
        const releasedAt = now();
        queuedCalls = queue.length;
        for (const item of queue) longestQueuedMs = Math.max(longestQueuedMs, releasedAt - item.queuedAt);
        // Only a section that made other callers wait is worth a line. It goes to stderr: some
        // scripts that reach this path print JSON on stdout.
        if (queuedCalls > 0) {
          try {
            logger.warn?.(`[storage:exclusive] ${label} heldMs=${Math.round(releasedAt - acquiredAt)}`
              + ` waitedMs=${Math.round(acquiredAt - requestedAt)} queuedCalls=${queuedCalls}`
              + ` longestQueuedMs=${Math.round(longestQueuedMs)}`);
          } catch {
            // Diagnostics must never become the failure.
          }
        }
        if (closeOnRelease) {
          const close = closeOnRelease;
          closeOnRelease = null;
          close();
        }
        drain();
      }
      releaseSection();
    }
  }

  return {
    runExclusive,
    isHeld: () => held,
  };
}
