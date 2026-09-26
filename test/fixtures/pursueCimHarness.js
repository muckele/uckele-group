export function createDeterministicClock(initialIso = '2026-08-12T15:00:00.000Z') {
  let currentMs = Date.parse(initialIso);
  if (!Number.isFinite(currentMs)) throw new Error('Deterministic clock requires a valid ISO instant.');
  return {
    now() {
      return new Date(currentMs);
    },
    set(iso) {
      const nextMs = Date.parse(iso);
      if (!Number.isFinite(nextMs)) throw new Error('Deterministic clock requires a valid ISO instant.');
      currentMs = nextMs;
      return this.now();
    },
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds)) throw new Error('Clock advance must be finite.');
      currentMs += milliseconds;
      return this.now();
    },
  };
}
export function createDeterministicNonceSource(prefix = 'pursue-cim-nonce') {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-${String(sequence).padStart(4, '0')}`;
  };
}

export function createPursueCimProviderFake({ crashAt = '' } = {}) {
  const seamEntries = [];
  const providerCalls = [];
  const inboundEvents = [];
  const maybeCrash = (boundary) => {
    if (crashAt !== boundary) return;
    const error = new Error(`Synthetic crash at ${boundary}`);
    error.code = 'SYNTHETIC_CIM_CRASH';
    throw error;
  };
  return {
    seamEntries,
    providerCalls,
    inboundEvents,
    async execute(request) {
      maybeCrash('before-seam');
      seamEntries.push(structuredClone(request));
      maybeCrash('after-seam');
      providerCalls.push(structuredClone(request));
      maybeCrash('after-provider-call');
      return { providerMessageId: `synthetic-provider-${providerCalls.length}` };
    },
    recordInbound(event) {
      inboundEvents.push(structuredClone(event));
    },
  };
}
