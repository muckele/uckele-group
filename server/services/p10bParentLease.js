// Existing IPC is a lifetime lease for a local controller, independent of the
// guest guardian. Losing its owner may only cancel local work and retain failure.
export function createP10bParentLease({ owner = process, onLoss = () => {} } = {}) {
  if (owner.connected !== true || typeof owner.send !== 'function') throw Error('Parent IPC required');
  const controller = new AbortController(); let lost = false;
  const events = ['disconnect', 'SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
  const lose = () => {
    if (lost) return; lost = true; controller.abort();
    void Promise.resolve().then(onLoss).catch(() => {});
  };
  for (const event of events) owner.on(event, lose);
  return { signal: controller.signal,
    assertActive() { if (lost || owner.connected !== true) throw Error('Parent lease lost'); },
    close() { for (const event of events) owner.removeListener(event, lose); } };
}
