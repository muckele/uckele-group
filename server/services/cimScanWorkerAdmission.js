const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createSingleCimScanAdmission() {
  let owner = null;
  return Object.freeze({
    async acquire(requestId) {
      if (!requestIdPattern.test(String(requestId || ''))) {
        throw new Error('Worker admission request identity is invalid.');
      }
      if (owner !== null) return null;
      owner = requestId;
      return () => {
        if (owner === requestId) owner = null;
      };
    },
  });
}
