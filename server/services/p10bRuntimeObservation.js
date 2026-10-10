import { StringDecoder } from 'node:string_decoder';
import { sha256, stableCanonicalJson } from '../utils/security.js';
import { P10B_GUARDIAN_EXIT_PREFIX } from './p10bGuardianParent.js';
import { parseP10bGuestWindow } from './p10bGuestShutdown.js';

const digest = value => sha256(stableCanonicalJson(value));
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const recordKeys = 'bindingVerified,code,exitedAt,guardianPid,parentPid,parentStartedAt,productionReady,readyDigest,receiptDigest,signal,spawnFailed,startDigest,version,windowDigest';

// fly --json emits whitespace-separated, pretty-printed JSON objects.
// Decode bounded complete objects in memory; callers retain only lifecycle fields.
export function createJsonObjectFramer(onObject, { maximumBytes = 131072 } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', bytes = 0, depth = 0, inString = false, escaped = false, failed = false;
  function consume(text) {
    if (failed) throw Error('JSON framing already failed');
    try {
      for (const char of text) {
        if (depth === 0) {
          if (/[ \t\r\n]/u.test(char)) continue;
          if (char !== '{') throw Error('Expected JSON object');
        }
        bytes += Buffer.byteLength(char);
        if (bytes > maximumBytes) throw Error('JSON object exceeds bound');
        buffer += char;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            const object = JSON.parse(buffer);
            buffer = ''; bytes = 0;
            onObject(object);
          }
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  }
  return {
    write: chunk => consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
    finish() {
      consume(decoder.end());
      if (depth !== 0) { failed = true; throw Error('Incomplete JSON object'); }
    },
  };
}

// Anchor the periodic schedule before the initial asynchronous read starts.
// The existing busy and strict observation-gap guards remain in the caller.
export function startObserverCadence(tick, { setInterval: interval = globalThis.setInterval } = {}) {
  const timer = interval(tick, 750);
  return { timer, initial: tick() };
}

// The old ambiguous init message never substitutes for this OS-reaped child
// event. Whole-Machine code0 and continuous stopped readback are also required.
export function proveP10bGuardianStop(records, { window, readiness, killedAt, expectedInstanceId } = {}) {
  parseP10bGuestWindow(JSON.stringify(window));
  let exit = null; let log = null; let malformed = false; const matches = [];
  const guardianPid = readiness?.guardianReady?.pid;
  const parent = readiness?.guardianParentStart;
  const windowDigest = digest(window);
  for (const row of records) {
    if (row.kind !== 'platform-log' || !row.message?.startsWith(P10B_GUARDIAN_EXIT_PREFIX)
      || Date.parse(row.timestamp) < Date.parse(window.issuedAt)) continue;
    try { matches.push({ row, event: JSON.parse(row.message.slice(P10B_GUARDIAN_EXIT_PREFIX.length)) }); }
    catch { malformed = true; }
  }
  if (matches.length === 1) {
    const candidate = matches[0]; const event = candidate.event;
    try {
      if (Object.keys(event).sort().join(',') === recordKeys && event.version === 'p10b-guardian-child-exit-v1'
        && event.windowDigest === windowDigest && event.productionReady === false && event.bindingVerified === true
        && event.code === 0 && event.signal === null && event.spawnFailed === false
        && Number.isSafeInteger(guardianPid) && guardianPid > 1 && event.guardianPid === guardianPid
        && Number.isSafeInteger(parent?.pid) && parent.pid > 1 && parent.pid !== guardianPid
        && event.parentPid === parent.pid && parent.windowDigest === windowDigest
        && parent.version === 'p10b-guardian-parent-start-v1' && event.parentStartedAt === parent.startedAt
        && readiness.sourceHead === window.sourceHead && readiness.guardianStart?.pid === guardianPid
        && readiness.guardianAlive === true && readiness.parentAlive === true
        && readiness.guardianStart.windowDigest === windowDigest && readiness.guardianReady.windowDigest === windowDigest
        && event.startDigest === digest(readiness.guardianStart) && event.readyDigest === digest(readiness.guardianReady)
        && /^[a-f0-9]{64}$/.test(event.receiptDigest) && time(event.exitedAt) && time(parent.startedAt)
        && time(readiness.guardianStart.startedAt) && Date.parse(parent.startedAt) >= Date.parse(window.issuedAt)
        && Date.parse(parent.startedAt) <= Date.parse(readiness.guardianStart.startedAt)
        && Date.parse(readiness.guardianStart.startedAt) <= Date.parse(event.exitedAt)
        && Date.parse(event.exitedAt) > killedAt && Date.parse(event.exitedAt) <= Date.parse(window.stopAt) - window.stopReserveMs
        && candidate.row.machineId === window.machineId && candidate.row.region === 'ewr'
        && Date.parse(candidate.row.timestamp) >= Date.parse(event.exitedAt)
        && Date.parse(candidate.row.timestamp) <= Date.parse(window.stopAt)) { exit = event; log = candidate.row; }
    } catch { malformed = true; }
  }
  const metadata = records.filter(row => row.kind === 'metadata');
  const stop = exit && metadata.find(row => row.state === 'stopped' && row.imageDigest === window.imageDigest
    && row.instanceId === expectedInstanceId && Date.parse(row.at) >= Date.parse(exit.exitedAt));
  const machineExit = stop?.events?.find(event => event.type === 'exit' && event.status === 'stopped'
    && Date.parse(event.request?.exit_event?.exited_at) >= Date.parse(exit.exitedAt))?.request?.exit_event;
  const normalMachineExit = machineExit && machineExit.requested_stop === false && machineExit.restarting === false
    && machineExit.guest_exit_code === 0 && machineExit.exit_code === 0 && machineExit.guest_signal === -1
    && machineExit.signal === -1 && machineExit.guest_error === '' && machineExit.error === ''
    && machineExit.oom_killed === false && Date.parse(machineExit.exited_at) <= Date.parse(stop.at);
  const gaps = metadata.slice(1).map((row, i) => Date.parse(row.requestedAt) - Date.parse(metadata[i].requestedAt));
  const responseGaps = metadata.slice(1).map((row, i) => Date.parse(row.at) - Date.parse(metadata[i].at));
  const completion = records.find(row => row.kind === 'observer-finished' && row.normalCompletion === true);
  const observerContinuous = metadata.length >= 2 && metadata.every(row => time(row.requestedAt) && time(row.at)
    && Date.parse(row.at) >= Date.parse(row.requestedAt) && row.imageDigest === window.imageDigest && row.instanceId === expectedInstanceId)
    && gaps.every(ms => ms >= 0 && ms <= 1000) && responseGaps.every(ms => ms >= 0 && ms <= 1000)
    && Date.parse(metadata[0]?.requestedAt) <= killedAt && Date.parse(metadata.at(-1)?.requestedAt) >= Date.parse(window.stopAt)
    && completion && time(completion.at) && records.filter(row => row.kind === 'observer-finished').length === 1
    && Date.parse(completion.at) >= Date.parse(window.stopAt)
    && Date.parse(completion.at) >= Date.parse(metadata.at(-1)?.at)
    && Date.parse(completion.at) - Date.parse(metadata.at(-1)?.requestedAt) <= 1000
    && !records.some(row => ['observer-read-error', 'observer-missed-poll', 'observer-parse-error', 'log-attachment-failed'].includes(row.kind)
      || (row.kind === 'local-reader-exit' && row.reader === 'logs'));
  const unexpectedRestart = Boolean(stop && metadata.some(row => Date.parse(row.at) > Date.parse(stop.at) && row.state !== 'stopped'));
  const stopLatencyMs = exit && stop ? Date.parse(stop.at) - Date.parse(exit.exitedAt) : null;
  const success = Boolean(typeof expectedInstanceId === 'string' && expectedInstanceId.length > 0
    && Number.isFinite(killedAt) && killedAt >= Date.parse(window.issuedAt) && killedAt < Date.parse(window.stopAt)
    && !malformed && matches.length === 1 && exit && log && stop && normalMachineExit
    && observerContinuous && !unexpectedRestart && stopLatencyMs >= 0 && stopLatencyMs <= 30000
    && Date.parse(stop.at) <= Date.parse(window.stopAt));
  return { success, guardianPid, parentPid: parent?.pid ?? null, exitedAt: exit?.exitedAt ?? null,
    stoppedAt: stop?.at ?? null, exitSource: exit ? 'guardian-parent-os-exit' : null, stopLatencyMs,
    normalMachineExit: Boolean(normalMachineExit), observerContinuous: Boolean(observerContinuous), unexpectedRestart,
    exitRecordCount: matches.length, maximumMetadataPollGapMs: gaps.length ? Math.max(...gaps) : null,
    maximumMetadataResponseGapMs: responseGaps.length ? Math.max(...responseGaps) : null, productionReady: false };
}
