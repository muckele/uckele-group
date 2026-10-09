import fs from 'node:fs';
import { assertQualificationHardOff } from './p10bQualificationContract.js';
import { P10B_MACHINE_ID, p10bDatabaseIdentity, p10bPublicConfigurationDigest } from './p10bRuntime.js';
import { parseP10bGuestWindow, writeP10bGuestRecord } from './p10bGuestShutdown.js';
import { sha256, stableCanonicalJson } from '../utils/security.js';

function binding(config, runtime) {
  assertQualificationHardOff(config);
  if (runtime.app !== 'uckele-group-p10b' || runtime.machineId !== P10B_MACHINE_ID
    || !/^[0-9a-f]{40}$/.test(runtime.sourceHead || '')
    || !['prepare', 'qualify'].includes(config.dealHunter.cimProvider.qualificationPhase)) {
    throw new Error('Isolated ingress closure binding failed');
  }
  return { app: runtime.app, machineId: runtime.machineId, sourceHead: runtime.sourceHead,
    phase: config.dealHunter.cimProvider.qualificationPhase,
    guestWindowDigest: config.dealHunter.cimProvider.qualificationGuestWindow
      ? sha256(stableCanonicalJson(parseP10bGuestWindow(config.dealHunter.cimProvider.qualificationGuestWindow, runtime))) : null };
}

// Local signal and retained files coordinate the two existing processes. There
// is no external endpoint or credential. The listener holds after draining;
// the independent Fly-configured guest guard exits to stop the whole Machine.
export function installP10bIngressClosure({ config, runtime, server, closeStorage,
  databasePath = config.storage.sqlitePath, processControl = process } = {}) {
  const expected = binding(config, runtime);
  const prefix = `${databasePath}.p10b-${expected.phase}-server`;
  writeP10bGuestRecord(`${prefix}.json`, { ...expected, pid: processControl.pid });
  const hold = setInterval(() => {}, 0x7fffffff);
  let closure;
  const close = () => {
    if (!closure) closure = (async () => {
      let timer;
      let closed = false;
      try {
        await Promise.race([new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
        }), new Promise((resolve, reject) => {
          timer = setTimeout(() => { server.closeAllConnections?.(); reject(new Error('Ingress drain timed out')); }, 8000);
        })]);
        await closeStorage();
        closed = true;
      } catch { /* Failed draining or SQLite close prevents proof promotion. */ }
      finally { clearTimeout(timer); }
      let receipt;
      try { receipt = { ...expected, closed, databaseIdentityHash: p10bDatabaseIdentity(databasePath),
        runtimeConfigurationDigest: p10bPublicConfigurationDigest(config) }; }
      catch { receipt = { ...expected, closed: false }; }
      writeP10bGuestRecord(`${prefix}-closed.json`, receipt);
      return receipt;
    })();
    return closure;
  };
  const onSignal = () => { void close().catch(() => {}); };
  processControl.on('SIGUSR2', onSignal);
  return { close, dispose() { clearInterval(hold); processControl.removeListener('SIGUSR2', onSignal); } };
}

export async function requestP10bIngressClosure({ config, runtime,
  databasePath = config.storage.sqlitePath, timeoutMs = 10000, signalProcess = process.kill } = {}) {
  const expected = binding(config, runtime);
  const prefix = `${databasePath}.p10b-${expected.phase}-server`;
  const deadline = Date.now() + Math.min(10000, timeoutMs);
  let sent = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(`${prefix}-closed.json`)) {
      const receipt = JSON.parse(fs.readFileSync(`${prefix}-closed.json`, 'utf8'));
      if (receipt.closed !== true || Object.entries(expected).some(([key, value]) => receipt[key] !== value)
        || receipt.databaseIdentityHash !== p10bDatabaseIdentity(databasePath)
        || receipt.runtimeConfigurationDigest !== p10bPublicConfigurationDigest(config)) {
        throw new Error('Ingress or database closure is unverified');
      }
      return receipt;
    }
    if (!sent && fs.existsSync(`${prefix}.json`)) {
      const server = JSON.parse(fs.readFileSync(`${prefix}.json`, 'utf8'));
      if (Object.entries(expected).some(([key, value]) => server[key] !== value)
        || !Number.isSafeInteger(server.pid) || server.pid < 1) throw new Error('Ingress server identity changed');
      signalProcess(server.pid, 'SIGUSR2'); sent = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Ingress closure acknowledgment timed out');
}
