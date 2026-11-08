// Names what stopped the server from answering. Fly's health check gives up after 5 seconds, and
// a stall that long leaves nothing in the logs on its own. The threshold is lower so a stall that
// nearly fails the check is seen too.
//
// Reading a stall line:
//   cpuMs close to blockedMs  the app's own code held the server; active/finished say which request
//   cpuMs far below blockedMs the app was waiting: CPU throttling on the shared VM or a slow disk
//   active and finished none  no request was involved: look at the scheduler lines around it
//
// Lines carry route patterns only, never real URLs or queries: paths can hold tokens and queries
// can hold email addresses.

const DEFAULT_STALL_THRESHOLD_MS = 2_000;
const DEFAULT_SLOW_REQUEST_MS = 2_000;
const DEFAULT_TICK_MS = 500;
const MAX_LABELS_IN_LINE = 5;
const MAX_FINISHED_REMEMBERED = 50;
const MAX_ROUTE_LENGTH = 150;

export function routeLabel(request) {
  const method = String(request?.method || 'UNKNOWN');
  if (!request?.route) return `${method} (no route)`;
  const pattern = `${request.baseUrl || ''}${String(request.route.path)}`
    .replace(/\s+/g, ' ')
    .slice(0, MAX_ROUTE_LENGTH);
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
  now = Date.now,
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
    let closed = false;
    response.once('close', () => {
      if (closed) return;
      closed = true;
      active.delete(request);
      const finishedAt = now();
      const durationMs = finishedAt - startedAt;
      const label = routeLabel(request);
      finished.push({ label, finishedAt, durationMs });
      if (finished.length > MAX_FINISHED_REMEMBERED) finished.shift();
      if (durationMs >= slowRequestMs) {
        warn(`[slow-request] ${label} status=${response.statusCode} durationMs=${durationMs}`
          + `${response.writableFinished ? '' : ' aborted'}`);
      }
    });
    next();
  }

  function tick() {
    const at = now();
    const cpu = cpuUsage();
    const blockedMs = at - lastTickAt - tickMs;
    if (blockedMs >= stallThresholdMs) {
      const cpuMs = Math.round(((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1_000);
      const activeLabels = [...active.keys()].map(routeLabel);
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
    }
    return { stop };
  }

  return { middleware, tick, start, stop };
}

export const eventLoopWatch = createEventLoopWatch();
