import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { openP10bNativeMachineClient } from './p10bNativeMachineClient.js';
import { createP10bOperatorProcesses } from './p10bOperatorProcesses.js';
import { readP10bPublicJson } from './p10bOperatorFiles.js';
import { proveP10bGuardianStop } from './p10bRuntimeObservation.js';
import { assertP10bRecoveryAdmission, assertP10bCurrentPhaseSettlement } from './p10bAdmissionRecovery.js';
import { P10B_GUARDIAN_EXIT_PREFIX } from './p10bGuardianParent.js';
import { sanitizeP10bGuardianLog } from './p10bRuntimeObserver.js';

const script = name => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
const digest = value => sha256(stableCanonicalJson(value));
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function verifyP10bPreparationObservation(rows, phase, machine, result) {
  const metadata = rows.filter(v => v.kind === 'metadata'); const last = metadata.at(-1);
  const logs = rows.filter(v => v.kind === 'platform-log');
  const log = logs[0]; let exit;
  try { if (log?.message.startsWith(P10B_GUARDIAN_EXIT_PREFIX)) exit = JSON.parse(log.message.slice(P10B_GUARDIAN_EXIT_PREFIX.length)); } catch { /* absent typed exit fails below */ }
  const completions = rows.filter(v => v.kind === 'observer-finished'); const completion = completions[0];
  const normal = metadata.find(v => v.state === 'stopped' && v.events?.some(e => {
    const x = e.request?.exit_event;
    return e.type === 'exit' && e.status === 'stopped' && x?.requested_stop === false && x.restarting === false
      && x.guest_exit_code === 0 && x.exit_code === 0 && x.guest_signal === -1 && x.signal === -1
      && x.guest_error === '' && x.error === '' && x.oom_killed === false
      && canonicalTime(x.exited_at) && Date.parse(x.exited_at) >= Date.parse(exit?.exitedAt)
      && Date.parse(x.exited_at) <= Date.parse(v.at);
  }));
  if (logs.length !== 1 || !exit || !sanitizeP10bGuardianLog({ message: log.message, timestamp: log.timestamp,
    instance: log.machineId, region: log.region }, phase.window)
    || exit.parentPid === exit.guardianPid || Date.parse(exit.parentStartedAt) < Date.parse(phase.window.issuedAt)
    || Date.parse(exit.parentStartedAt) > Date.parse(exit.exitedAt)
    || exit.windowDigest !== digest(phase.window) || exit.bindingVerified !== true
    || exit.code !== 0 || exit.signal !== null || exit.spawnFailed !== false || exit.productionReady !== false
    || exit.receiptDigest !== digest(result?.preparation?.guestShutdown || null)
    || !canonicalTime(exit.exitedAt) || Date.parse(exit.exitedAt) < Date.parse(phase.window.issuedAt)
    || Date.parse(exit.exitedAt) > Date.parse(phase.window.stopAt) - phase.window.stopReserveMs
    || !normal || Date.parse(normal.at) - Date.parse(exit.exitedAt) < 0 || Date.parse(normal.at) - Date.parse(exit.exitedAt) > 30000
    || Date.parse(normal.at) > Date.parse(phase.window.stopAt)
    || metadata.length < 2 || Date.parse(metadata[0].requestedAt) > Date.parse(phase.window.issuedAt) + 60000
    || Date.parse(last.requestedAt) < Date.parse(phase.window.stopAt)
    || completions.length !== 1 || completion.normalCompletion !== true || !canonicalTime(completion.at)
    || Date.parse(completion.at) < Date.parse(last.at) || Date.parse(completion.at) - Date.parse(last.requestedAt) > 1000
    || rows.some(v => ['observer-read-error', 'observer-missed-poll', 'observer-parse-error', 'local-reader-exit'].includes(v.kind))
    || metadata.some((v, i) => !canonicalTime(v.at) || !canonicalTime(v.requestedAt) || Date.parse(v.at) < Date.parse(v.requestedAt)
      || v.instanceId !== machine.instance_id || v.imageDigest !== phase.window.imageDigest
      || (i && (Date.parse(v.requestedAt) - Date.parse(metadata[i - 1].requestedAt) > 1000
        || Date.parse(v.requestedAt) - Date.parse(metadata[i - 1].requestedAt) < 0
        || Date.parse(v.at) - Date.parse(metadata[i - 1].at) > 1000
        || Date.parse(v.at) - Date.parse(metadata[i - 1].at) < 0)))
    || metadata.some(v => Date.parse(v.at) > Date.parse(normal.at) && v.state !== 'stopped')) throw Error('Preparation observation failed');
  return true;
}

// Concrete normal CLI/SDK wiring is dormant until the operator's positive
// recovery gate and exact session approval have both passed.
export async function createP10bNoEmailBoundaries({ session, approval, evidence, recovery, inspectRecovery,
  nativeExecutable, flyExecutable = '/opt/homebrew/bin/fly', nodeExecutable = process.execPath,
  processes = createP10bOperatorProcesses(), openNative = openP10bNativeMachineClient, clock = () => Date.now() }) {
  assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
  let native; let posts = 0; let settlementPhase; const configs = [session.baselineConfig];
  const observers = []; const controllers = [];
  async function authorizePhase(phase) {
    const listed = JSON.parse(await processes.command(flyExecutable, ['machines', 'list', '--app', session.app, '--json'], 10000));
    if (!Array.isArray(listed) || listed.length !== 1 || listed[0].id !== session.machineId) throw Error('Exact sole isolated Machine required');
    if (native && await native.close() !== true) throw Error('Previous native client not reaped');
    configs.push(phase.config);
    native = await openNative({ executable: nativeExecutable, session, approval, configs, recoveryVerified: true });
  }
  async function client(method = 'GET', body, timeout = 1000) {
    if (settlementPhase) {
      assertP10bCurrentPhaseSettlement({ session, recovery, inspect: inspectRecovery, phase: settlementPhase,
        evidenceRoot: evidence.root, now: clock() });
      if (method === 'POST' && stableCanonicalJson(body?.config) !== stableCanonicalJson(session.baselineConfig)) throw Error('Settlement only permits frozen baseline restoration');
    } else assertP10bRecoveryAdmission({ session, recovery, inspect: inspectRecovery, now: clock() });
    if (!native) native = await openNative({ executable: nativeExecutable, session, approval, configs, recoveryVerified: true });
    if (method === 'POST') { if (++posts > 3) throw Error('Stopped update budget consumed'); }
    return native.client(method, body, timeout);
  }
  async function startObserver({ phase, machine }) {
    const manifest = `p10b-runtime-only-${phase.label}-observer-input.json`;
    evidence.write(manifest, { session, approval, phase, machine, nativeExecutable, flyExecutable, recovery });
    const output = path.join(evidence.root, `p10b-runtime-only-${phase.label}-observer.jsonl`);
    const entry = processes.launch(nodeExecutable, [script('run-p10b-independent-observer.js'), path.join(evidence.root, manifest), output],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true });
    let stderrBytes = 0; entry.child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) void processes.terminate(entry); });
    let timer;
    try {
      const attached = await Promise.race([new Promise(resolve => entry.child.once('message', resolve)),
        entry.exited.then(() => { throw Error('Observer exited before attachment'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Observer attachment timeout')), 10000); })]);
      const observer = { ...attached, entry, output, phase }; observers.push(observer); return observer;
    } finally { clearTimeout(timer); }
  }
  async function observerRows(observer) {
    const left = Math.min(Date.parse(session.sessionDeadline), Date.parse(observer.phase.window.stopAt) + 30000) - clock(); let timer;
    if (!Number.isFinite(left) || left <= 0) throw Error('Observer absolute completion deadline expired');
    try {
      const terminal = await Promise.race([observer.entry.exited,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Observer completion timeout')), left); })]);
      if (terminal.code !== 0 || terminal.signal !== null) throw Error('Observer completion failed');
      const stat = fs.lstatSync(observer.output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw Error('Observer evidence bound');
      return fs.readFileSync(observer.output, 'utf8').trim().split('\n').map(v => JSON.parse(v));
    } finally { clearTimeout(timer); }
  }
  async function demonstrate({ phase, observer, machine }) {
    const input = 'p10b-runtime-only-demo-primary-input.json'; evidence.write(input, { session, approval, phase, recovery, flyExecutable,
      nativeExecutable, machine });
    const primary = processes.launch(nodeExecutable, [script('run-p10b-demo-primary.js'), path.join(evidence.root, input)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true });
    controllers.push(primary);
    let timer; let readiness;
    try { readiness = await Promise.race([new Promise(resolve => primary.child.once('message', resolve)),
      primary.exited.then(() => { throw Error('Demo primary exited before readiness'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Demo readiness timeout')), 15000); })]); }
    finally { clearTimeout(timer); }
    evidence.write('p10b-runtime-only-demo-readiness.json', readiness);
    if (readiness.sourceHead !== session.sourceHead || readiness.freshPathsVerified !== true) throw Error('Demo readiness binding failed');
    const killedAt = clock(); const primaryTerminationVerified = await processes.terminate(primary);
    if (!primaryTerminationVerified) throw Error('Primary reap uncertain');
    const terminal = await primary.exited;
    if (!primaryTerminationVerified || terminal.code !== null || terminal.signal !== 'SIGKILL') throw Error('Primary termination not verified');
    try { process.kill(observer.entry.child.pid, 0); } catch { throw Error('Independent observer lost'); }
    const rows = await observerRows(observer);
    const proof = proveP10bGuardianStop(rows, { window: phase.window, readiness, killedAt, expectedInstanceId: machine.instance_id });
    return { ...proof, windowDigest: digest(phase.window), observerSurvived: true, primaryTerminationVerified };
  }
  async function runPreparation({ phase, observer, machine }) {
    const prefix = path.join(evidence.root, 'p10b-runtime-only-preparation');
    const input = 'p10b-runtime-only-prepare-primary-input.json'; evidence.write(input, { session, approval, phase, recovery });
    const entry = processes.launch(nodeExecutable, [script('run-p10b-no-email-preparation.js'),
      path.join(evidence.root, input)], { detached: true });
    controllers.push(entry);
    // The child already retains public terminal results. Discard stdout and
    // stderr while keeping a hard byte bound; never copy raw application text.
    let bytes = 0; for (const stream of [entry.child.stdout, entry.child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length; if (bytes > 131072) void processes.terminate(entry);
    });
    const end = Date.parse(phase.window.stopAt) + 30000; let timer;
    let terminal;
    try { terminal = await Promise.race([entry.exited, new Promise((_, reject) => {
      timer = setTimeout(() => { void processes.terminate(entry); reject(Error('Preparation child timeout')); }, Math.max(1, end - clock())); })]); }
    finally { clearTimeout(timer); }
    evidence.write('p10b-runtime-only-preparation-child-exit.json', terminal);
    const result = readP10bPublicJson(`${prefix}.result.json`);
    verifyP10bPreparationObservation(await observerRows(observer), phase, machine, result);
    return { ...terminal, result };
  }
  async function settle(phase) {
    settlementPhase = phase;
    const controllersReaped = (await Promise.all(controllers.map(entry => processes.terminate(entry)))).every(v => v === true);
    const end = Math.min(Date.parse(phase.window.stopAt) + 30000, Date.parse(session.sessionDeadline) - 30000);
    let stopped = false;
    do {
      try { const machine = await client(); stopped = machine.state === 'stopped' && machine.id === session.machineId && machine.region === 'ewr'; }
      catch { /* retain uncertainty; only bounded read-only observation follows */ }
      if (stopped) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(750, Math.max(1, end - clock()))));
    } while (clock() < end);
    for (const observer of observers) { try { await observerRows(observer); } catch { /* failed proof never authorizes preparation */ } }
    evidence.write(`p10b-runtime-only-${phase.label}-settlement.json`, { stoppedVerified: stopped, controllersReaped, at: new Date(clock()).toISOString(),
      productionReady: false, providerCalls: 0, hostStopCalls: 0 });
    return stopped && controllersReaped;
  }
  return { authorizePhase, client, startObserver, demonstrate, runPreparation, settle,
    async reap() { return processes.reap(); }, async close() { return !native || await native.close(); } };
}
