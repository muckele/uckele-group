import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { assertP10bReviewedCheckout } from './p10bOperatorSource.js';
import { createP10bRecoveryFilesystem } from './p10bOperatorFiles.js';
import { createP10bStoppedLogProbeTokenContext } from './p10bHostAuthentication.js';
import { openP10bNativeStoppedLogProbeClient } from './p10bNativeStoppedLogProbeClient.js';
import { assertP10bStoppedLogProbeApproval, createP10bStoppedLogProbeBudget, checkedP10bStoppedLogObservation,
  P10B_STOPPED_LOG_PROBE_STEPS, P10B_STOPPED_LOG_PROBE_BUDGETS } from './p10bStoppedLogProbeContract.js';
function evidence(probe) {
  const filesystem = createP10bRecoveryFilesystem(); const directory = probe.evidenceDirectory; const anchor = filesystem.anchorDirectory(directory);
  if (!anchor.ownerControlled) throw Error('Canonical owner0700 probe evidence required');
  const check = () => { if (stableCanonicalJson(filesystem.anchorDirectory(directory)) !== stableCanonicalJson(anchor)) throw Error('Probe directory changed'); };
  const names = { intent: `p10b-stopped-log-probe-${probe.nonce}-intent.json`, terminal: `p10b-stopped-log-probe-${probe.nonce}-terminal.json` };
  for (const name of Object.values(names)) if (filesystem.exists(path.join(directory, name))) throw Error('Probe nonce already consumed');
  return { write(kind, value) {
    check(); const file = path.join(directory, names[kind]); const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, `${stableCanonicalJson(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    check(); const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } check();
  }, check };
}
export async function runP10bStoppedLogProbe({ probe, approval, executable, environment = process.env, signal,
  checkSource = assertP10bReviewedCheckout, clock = Date.now, monotonicClock = () => performance.now(), createContext = createP10bStoppedLogProbeTokenContext,
  openClient = openP10bNativeStoppedLogProbeClient }) {
  const budget = createP10bStoppedLogProbeBudget(probe, { clock, monotonicClock });
  assertP10bStoppedLogProbeApproval(probe, approval, clock());
  checkSource(probe.hostSourceHead);
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024 || sha256(fs.readFileSync(executable)) !== probe.nativeClientSha256) throw Error('Exact stopped probe executable required');
  if (!budget.active() || signal?.aborted) throw Error('Stopped probe deadline ended');
  const store = evidence(probe); const probeDigest = sha256(stableCanonicalJson(probe));
  store.write('intent', { version: 'p10b-stopped-log-probe-intent-v1', nonce: probe.nonce, probeDigest, consumedAt: new Date(clock()).toISOString() });
  const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  let context; let client; let ownedClient; let cleanupBegan = false; let ownedReap; let reaped = false; let contextClosed = false; let complete = false; const observations = [];
  const bounded = async (work, limit, cleanup = false) => {
    let timer; const began = monotonicClock();
    try {
      const result = await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Stopped probe timeout')); }, Math.max(1, Math.min(limit, budget.remaining(cleanup)))); })]);
      if (!budget.active(cleanup) || monotonicClock() - began >= limit || (!cleanup && controller.signal.aborted)) throw Error('Stopped probe timeout');
      return result;
    } finally { clearTimeout(timer); }
  };
  const reapOwned = () => { if (!ownedReap) ownedReap = Promise.resolve().then(() => ownedClient.reap()).catch(() => false); return ownedReap; };
  try {
    if (!budget.active() || controller.signal.aborted) throw Error(); store.check();
    context = createContext({ probe, approval, environment, clock });
    if (!budget.active() || controller.signal.aborted) throw Error();
    const opening = Promise.resolve().then(() => openClient({ probe, approval, executable, environment: context.environment, signal: controller.signal, clock, monotonicClock, budget }));
    // A late initialization is still cleanup-owned and cannot become success.
    opening.then(value => {
      // Ownership precedes deadline admission, including an overdue resolution
      // whose timeout callback has not run. Late closure never upgrades result.
      ownedClient = value;
      if (cleanupBegan) void reapOwned();
    }, () => {});
    client = await bounded(() => opening, 10000);
    for (const [index, operation] of P10B_STOPPED_LOG_PROBE_STEPS.entries()) {
      if (!budget.active() || controller.signal.aborted) throw Error(); store.check();
      const observed = await bounded(() => client.step(operation), P10B_STOPPED_LOG_PROBE_BUDGETS[index]);
      observations.push(checkedP10bStoppedLogObservation(observed, operation, probe));
      if (!budget.active()) throw Error();
    }
    complete = true;
  } catch (error) { if (!client) reaped = error?.reapVerified === true; }
  finally {
    cleanupBegan = true; controller.abort();
    if (ownedClient) { try { reaped = await bounded(reapOwned, 1000, true) === true; } catch { reaped = false; } }
    if (context && reaped && budget.active(true)) {
      try { contextClosed = context.cleanup({ reaped: true }) === true && budget.active(true); } catch { contextClosed = false; }
    }
    signal?.removeEventListener('abort', abort);
  }
  const result = { version: 'p10b-stopped-log-probe-result-v1', probeDigest, success: complete && reaped && contextClosed && budget.active(true),
    beforeBaselineVerified: observations[0]?.kind === 'baseline', afterBaselineVerified: observations[3]?.kind === 'baseline',
    firstProviderBatchEmpty: observations[1]?.providerBatchEmpty ?? null, steadyProviderBatchEmpty: observations[2]?.providerBatchEmpty ?? null,
    reapVerified: reaped, privateContextClosed: contextClosed, starts: 0, stoppedConfigUpdates: 0, successfulMachineSamples: observations.filter(v => v.kind === 'baseline').length,
    successfulLogSamples: observations.filter(v => v.kind === 'log').length, productionReady: false, qualificationAllowed: false, globalAutomationPaused: true,
    continuousStoppedStateProven: false, runtimeReady: false, terminalAt: new Date(clock()).toISOString() };
  // A durable file cannot attest its own fsync completion time. Retained facts
  // are always non-authoritative; only the returned, post-fsync checked receipt
  // may report success. A late/failed fsync cannot leave success:true on disk.
  try { store.write('terminal', { ...result, success: false, publicationVerified: false });
    result.terminalPublished = true; result.publicationVerified = budget.active(true);
    if (!result.publicationVerified) result.success = false; }
  catch { result.success = false; result.terminalPublished = false; }
  return result;
}
