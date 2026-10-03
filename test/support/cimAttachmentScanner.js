export function createDeterministicFakeScanner({
  defaultOutcome = 'unavailable',
  outcomesBySha256 = {},
} = {}) {
  const allowed = new Set(['clean', 'unsafe', 'unavailable']);
  if (!allowed.has(defaultOutcome)) throw new Error('Fake scanner default outcome is invalid.');
  return {
    name: 'deterministic-fake',
    version: '1',
    async scan({ sha256 }) {
      const outcome = outcomesBySha256[sha256] || defaultOutcome;
      if (!allowed.has(outcome)) throw new Error('Fake scanner configured an invalid outcome.');
      return { outcome };
    },
  };
}
