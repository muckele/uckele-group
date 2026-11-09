// Helps explain why the server stopped answering. Fly's health check gives up after 5 seconds, and
// a stall that long leaves nothing in the logs on its own. The threshold is lower so a stall that
// nearly fails the check is seen too.
//
// Reading a stall line:
//   cpuMs high    this process was busy, on its main thread or its helpers. cpuMs covers the whole
//                 process, so it can exceed blockedMs.
//   cpuMs low     the main thread was not running: a synchronous wait in the app's own code (a SQLite
//                 lock, a sync file read), a slow disk, or CPU throttling on the shared VM, which the
//                 app may have caused itself. The numbers alone can't separate these.
//   active and finished  requests running then or just finished, each with its age or duration. They
//                 are candidates, not proof: a request waiting on the network is listed too. A culprit
//                 in finished shows a duration close to blockedMs.
//   none and none no request was involved: a background job or something outside the app. Compare
//                 the time with the job schedules, because some jobs log nothing.
//
// Limits: blockedMs can understate a block by up to one tick, so a block just over the threshold may go
// unlogged. Shorter blocks are judged one at a time, so several can add up to a failed check unseen.
//
// Lines carry route patterns and mount paths only, never real URLs or queries: paths can hold tokens
// and queries can hold email addresses. Every app.use mount is a literal today; mounting on a :param
// path would put its real value in the (no route) label.

const DEFAULT_STALL_THRESHOLD_MS = 2_000;
const DEFAULT_SLOW_REQUEST_MS = 2_000;
const DEFAULT_TICK_MS = 500;
const MAX_LABELS_IN_LINE = 5;
const MAX_FINISHED_REMEMBERED = 50;
const MAX_ROUTE_LENGTH = 150;

export function routeLabel(request) {
  const method = String(request?.method || 'UNKNOWN');
  const routePath = request?.route ? String(request.route.path) : '';
  const pattern = `${request?.baseUrl || ''}${routePath}`
    .replace(/\s+/g, ' ')
    .slice(0, MAX_ROUTE_LENGTH);
  if (!request?.route) return pattern ? `${method} ${pattern} (no route)` : `${method} (no route)`;
  return `${method} ${pattern}`;
}

function boundedList(labels) {
  if (labels.length === 0) return 'none';
  const shown = labels.slice(0, MAX_LABELS_IN_LINE).join(',');
  const hidden = labels.length - MAX_LABELS_IN_LINE;
  return hidden > 0 ? `${shown},+${hidden} more` : shown;
}

export function createEventLoopWatch({
  logger = console,
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  slowRequestMs = DEFAULT_SLOW_REQUEST_MS,
  tickMs = DEFAULT_TICK_MS,
  now = () => performance.now(),
  cpuUsage = process.cpuUsage,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const active = new Map();
  const finished = [];
  let lastTickAt = now();
  let lastCpu = cpuUsage();
  let timer = null;

  // Diagnostics must never become the failure: a logger that throws stays inside this module.
  const warn = (line) => {
    try {
      logger.warn(line);
    } catch {
      // Nothing useful can be done with a broken logger here.
    }
  };

  function middleware(request, response, next) {
    const startedAt = now();
    active.set(request, startedAt);
    response.once('close', () => {
      active.delete(request);
      const finishedAt = now();
      const durationMs = Math.round(finishedAt - startedAt);
      const label = routeLabel(request);
      finished.push({ label, finishedAt, durationMs });
      if (finished.length > MAX_FINISHED_REMEMBERED) finished.shift();
      if (durationMs >= slowRequestMs) {
        const status = response.headersSent ? response.statusCode : 'none';
        warn(`[slow-request] ${label} status=${status} durationMs=${durationMs}`
          + `${response.writableFinished ? '' : ' aborted'}`);
      }
    });
    next();
  }

  function tick() {
    const at = now();
    const cpu = cpuUsage();
    // A pipelined request queued behind another never gets a close event if its connection drops.
    for (const request of active.keys()) {
      if (request.socket?.destroyed) active.delete(request);
    }
    const blockedMs = Math.round(at - lastTickAt - tickMs);
    if (blockedMs >= stallThresholdMs) {
      const cpuMs = Math.round(((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1_000);
      const activeLabels = [...active].map(([request, startedAt]) =>
        `${routeLabel(request)}:${Math.round(at - startedAt)}ms`);
      const finishedLabels = finished
        .filter((item) => item.finishedAt >= lastTickAt)
        .map((item) => `${item.label}:${item.durationMs}ms`);
      warn(`[event-loop-stall] blockedMs=${blockedMs} cpuMs=${cpuMs}`
        + ` active=${boundedList(activeLabels)} finished=${boundedList(finishedLabels)}`);
    }
    lastTickAt = at;
    lastCpu = cpu;
  }

  function stop() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function start() {
    if (timer === null) {
      lastTickAt = now();
      lastCpu = cpuUsage();
      timer = setTimer(tick, tickMs);
      timer.unref?.();
      // Silence otherwise can't tell "no stalls" from "not running".
      try {
        logger.info?.(`[event-loop-watch] started stallThresholdMs=${stallThresholdMs} slowRequestMs=${slowRequestMs}`);
      } catch {
        // Same reasoning as warn().
      }
    }
    return { stop };
  }

  return { middleware, tick, start, stop };
}

export const eventLoopWatch = createEventLoopWatch();
