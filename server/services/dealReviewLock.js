// One deal review build, and the score refresh around it, at a time in this process.
//
// The review build and the refresh now return to the event loop between steps (see
// utils/eventLoopSlices.js). Before that, each ran as one synchronous block, so two of them
// could never interleave even when the scheduler, the external cron and an admin request
// started them together. This lock keeps that guarantee: a second build or refresh waits for
// the first to finish.
//
// The lock is not reentrant. Code that already holds it passes the token it was given down
// to the calls that would otherwise acquire it again.

let chain = Promise.resolve();
const heldTokens = new WeakSet();

/** Runs `body(token)` once every earlier holder has finished. */
export async function withDealReviewLock(body) {
  const previous = chain;
  let release;
  chain = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const token = Object.freeze({});
  heldTokens.add(token);
  try {
    return await body(token);
  } finally {
    heldTokens.delete(token);
    release();
  }
}

/** Whether `token` is the token of the current holder. */
export function holdsDealReviewLock(token) {
  return Boolean(token) && typeof token === 'object' && heldTokens.has(token);
}

/** Runs `body(token)` under the lock, reusing `token` when it is the current holder's. */
export function withDealReviewLockHeld(token, body) {
  return holdsDealReviewLock(token) ? body(token) : withDealReviewLock(body);
}
