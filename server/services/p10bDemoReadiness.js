import { stableCanonicalJson } from '../utils/security.js';

// Reuse the immutable intent written before primary launch. Neither native
// initialization, machine start nor SSH may renew the parent's existing gate.
function p10bDemoReadinessDeadline(intent, phase, now) {
  if (!intent || Object.keys(intent).sort().join(',') !== 'at,window'
    || typeof intent.at !== 'string' || !Number.isFinite(Date.parse(intent.at))
    || new Date(intent.at).toISOString() !== intent.at
    || stableCanonicalJson(intent.window) !== stableCanonicalJson(phase.window)
    || Date.parse(intent.at) < Date.parse(phase.window.issuedAt) || Date.parse(intent.at) > now) {
    throw Error('Demo start intent binding failed');
  }
  const deadline = Date.parse(intent.at) + 15000;
  p10bDemoReadinessRemaining(deadline, now);
  return deadline;
}

function p10bDemoReadinessRemaining(deadline, now, reserveMs = 0) {
  const left = Math.floor(deadline - now - reserveMs);
  if (!Number.isSafeInteger(left) || left <= 0) throw Error('Demo readiness timeout');
  return left;
}

export function createP10bDemoReadinessBudget(intent, phase, { clock, monotonicClock }) {
  const now = clock(); const deadline = p10bDemoReadinessDeadline(intent, phase, now);
  const elapsedDeadline = monotonicClock() + p10bDemoReadinessRemaining(deadline, now);
  // Wall time still binds the frozen intent. Monotonic time also rejects an
  // overdue queued message after a stalled launch and wall-clock rollback.
  return reserveMs => Math.min(p10bDemoReadinessRemaining(deadline, clock(), reserveMs),
    p10bDemoReadinessRemaining(elapsedDeadline, monotonicClock(), reserveMs));
}

// Owned termination allows1500ms; retain another500ms for public evidence/IPC.
export const P10B_DEMO_READINESS_RESERVE_MS = 2000;
