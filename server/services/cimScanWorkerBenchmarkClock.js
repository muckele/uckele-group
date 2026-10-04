const staleOffsetMs = 25 * 60 * 60 * 1_000;

export function createCimScanStaleBenchmarkClock({ wallNow } = {}) {
  if (typeof wallNow !== 'function') {
    throw new Error('A real wall clock is required for the stale-signature benchmark.');
  }
  return function benchmarkNow() {
    const value = wallNow();
    const current = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(current.getTime())) throw new Error('Benchmark wall clock is invalid.');
    return new Date(current.getTime() + staleOffsetMs);
  };
}
