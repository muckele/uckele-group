import { createHash } from 'node:crypto';

export function sourceSafetyRunId(sourceId, runId) {
  const framed = [sourceId, runId].map((part) => {
    const value = JSON.stringify(part);
    return [Buffer.byteLength(value), value];
  });
  return `cim-source:${createHash('sha256').update(JSON.stringify(framed)).digest('hex')}`;
}

export function importOutreachDelta(before, after) {
  if (!before || !after) return {};
  const increase = (key) => Math.max(0, after[key] - before[key]);
  return {
    outreachCreated: ['ownerDecisions', 'enrollments', 'campaigns', 'transmissions',
      'memberships', 'crmOutbound', 'outbox', 'providerAuthorizations',
      'providerPending', 'providerSeamEntries']
      .reduce((total, key) => total + increase(key), 0),
    touchesScheduled: increase('touches'),
    providerSeamEntries: increase('providerSeamEntries'),
  };
}
