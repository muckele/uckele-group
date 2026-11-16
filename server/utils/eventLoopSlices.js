// Lets long jobs share the event loop.
//
// Most SQLite storage methods are `async` but never wait on anything, so `await storage.x()`
// continues in the same macrotask. A job built from such calls and from long loops runs as
// one block until its next real network or file read: at 5,000 Sheet rows the 07:30 sync was
// a single 16-second block, during which no request, health check or timer could run.
//
// Work written as a generator can run two ways without duplicating its logic: `runSteps`
// runs it to the end at once, for callers that need a synchronous answer, and
// `runStepsInSlices` returns to the event loop whenever a slice has run for `sliceMs`. Each
// `yield` in the generator marks a point where stopping is safe. Results are identical
// either way; only the timing differs.

export const defaultSliceMs = 40;

let configuredSliceMs = defaultSliceMs;

/**
 * Sets the slice length every slicer created afterwards uses, and returns a function that
 * restores the previous value. Tests use 0 so a job yields at every step and the largest
 * unsliced step can be measured.
 */
export function setEventLoopSliceMs(sliceMs) {
  const previous = configuredSliceMs;
  configuredSliceMs = Math.max(0, Number(sliceMs) || 0);
  return () => {
    configuredSliceMs = previous;
  };
}

/** Resolves on a later event-loop turn, after pending I/O and timers have had their turn. */
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A slice clock shared by the steps of one job. `due()` is cheap enough to call per item;
 * `yield()` returns to the event loop and starts a new slice.
 */
export function createEventLoopSlicer({ sliceMs = configuredSliceMs, now = () => performance.now() } = {}) {
  let sliceStartedAt = now();
  const slicer = {
    due() {
      return now() - sliceStartedAt >= sliceMs;
    },
    async yield() {
      await yieldToEventLoop();
      sliceStartedAt = now();
    },
    async maybeYield() {
      if (slicer.due()) await slicer.yield();
    },
  };
  return slicer;
}

/** Runs a step generator to completion synchronously and returns its result. */
export function runSteps(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Runs a step generator, returning to the event loop between steps once a slice is due. */
export async function runStepsInSlices(steps, slicer = createEventLoopSlicer()) {
  let step = steps.next();
  while (!step.done) {
    if (slicer.due()) await slicer.yield();
    step = steps.next();
  }
  return step.value;
}

/** `items.map(mapper)`, in slices. */
export async function mapInSlices(items, mapper, slicer = createEventLoopSlicer()) {
  const results = new Array(items.length);
  for (let index = 0; index < items.length; index += 1) {
    if (slicer.due()) await slicer.yield();
    results[index] = mapper(items[index], index);
  }
  return results;
}
