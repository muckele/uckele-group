export function createSyntheticReplayStore({
  maxEntries = 10_000,
  now = () => new Date(),
} = {}) {
  const entries = new Map();
  const currentTime = () => {
    const value = now();
    const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error('Synthetic replay clock is invalid.');
    return parsed;
  };
  const pruneExpiredRequests = (at) => {
    for (const [identity, entry] of entries) {
      if (Date.parse(entry.expiresAt) <= at) entries.delete(identity);
    }
  };
  return {
    entries,
    async claim({ keyId, requestId, requestDigest, expiresAt }) {
      const at = currentTime();
      pruneExpiredRequests(at);
      const identity = `${keyId}:${requestId}`;
      const existing = entries.get(identity);
      if (existing) {
        if (existing.requestDigest !== requestDigest) return { status: 'conflict' };
        if (existing.resultWire && existing.resultExpiresAt > at) {
          return { status: 'replay', resultWire: existing.resultWire };
        }
        if (existing.resultWire) {
          existing.resultWire = null;
          existing.resultExpiresAt = null;
        }
        return { status: 'inflight' };
      }
      if (entries.size >= maxEntries) return { status: 'capacity' };
      const requestExpiry = Date.parse(expiresAt);
      if (!Number.isFinite(requestExpiry) || requestExpiry <= at) return { status: 'capacity' };
      entries.set(identity, {
        requestDigest, expiresAt, resultWire: null, resultExpiresAt: null,
      });
      return { status: 'accepted' };
    },
    async complete({ keyId, requestId, requestDigest, resultWire }) {
      const at = currentTime();
      pruneExpiredRequests(at);
      const identity = `${keyId}:${requestId}`;
      const existing = entries.get(identity);
      if (!existing || existing.requestDigest !== requestDigest || existing.resultWire) return false;
      let result;
      try { result = JSON.parse(resultWire); } catch { return false; }
      const resultExpiresAt = Date.parse(result?.expiresAt || '');
      if (result?.keyId !== keyId || result?.requestId !== requestId
        || result?.requestDigest !== requestDigest
        || !Number.isFinite(resultExpiresAt) || resultExpiresAt <= at
        || resultExpiresAt > Date.parse(existing.expiresAt)) return false;
      existing.resultWire = resultWire;
      existing.resultExpiresAt = resultExpiresAt;
      return true;
    },
  };
}

export function createSyntheticAdmission() {
  let owner = null;
  return {
    async acquire(requestId) {
      if (owner) return null;
      owner = requestId;
      return () => {
        if (owner === requestId) owner = null;
      };
    },
  };
}

export function createSyntheticWorkerScanner({
  outcome = 'clean',
  preHealth,
  postHealth,
} = {}) {
  const defaultHealth = {
    healthy: true,
    daemonId: 'ClamAV synthetic-daemon',
    engineVersion: '1.synthetic',
    signatureVersion: 'synthetic-db-1',
    signatureUpdatedAt: '2026-10-03T11:55:00.000Z',
  };
  let healthCount = 0;
  return {
    scanCount: 0,
    async health() {
      healthCount += 1;
      return healthCount === 1 ? (preHealth || defaultHealth) : (postHealth || preHealth || defaultHealth);
    },
    async scan({ byteStream }) {
      this.scanCount += 1;
      for await (const _chunk of byteStream) { /* synthetic consumption */ }
      return {
        outcome,
        daemonId: (preHealth || defaultHealth).daemonId,
        reasonCode: outcome === 'clean' ? 'clean'
          : outcome === 'unsafe' ? 'malware_found'
            : outcome === 'ambiguous' ? 'scanner_response_ambiguous' : 'scanner_error',
      };
    },
  };
}
