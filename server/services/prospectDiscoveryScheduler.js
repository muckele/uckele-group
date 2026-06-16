import { getConfig } from '../config.js';
import { runConfiguredProspectDiscovery } from './prospectDiscovery.js';

export function startProspectDiscoveryScheduler() {
  const config = getConfig();
  const discovery = config.prospectDiscovery;

  if (!discovery.enabled || !discovery.schedulerEnabled) {
    console.log('[prospect-discovery:scheduler] disabled');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;

    try {
      const result = await runConfiguredProspectDiscovery({ requestedBy: 'prospect-discovery-scheduler' });
      console.log(
        `[prospect-discovery:scheduler] discovered ${result.discoveredCount || 0}; imported ${result.importedCount || 0}`,
      );
    } catch (error) {
      console.error(`[prospect-discovery:scheduler] failed: ${error.message}`);
    } finally {
      inFlight = false;
    }
  }

  function scheduleNext(delayMs = discovery.schedulerIntervalMs) {
    timer = setTimeout(async () => {
      await tick();

      if (!stopped) {
        scheduleNext();
      }
    }, Math.max(delayMs, 1000 * 60 * 15));

    if (timer.unref) {
      timer.unref();
    }
  }

  console.log(`[prospect-discovery:scheduler] enabled; interval ${discovery.schedulerIntervalMs}ms`);
  scheduleNext(1000 * 30);

  return {
    stop() {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
