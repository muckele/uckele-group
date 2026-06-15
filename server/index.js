import 'dotenv/config';
import { app } from './app.js';
import { getConfig } from './config.js';
import { sendDueOutreachMessages } from './services/prospectAutomation.js';

const config = getConfig();
const host = process.env.HOST || '0.0.0.0';
let outreachSchedulerRunning = false;

function startOutreachScheduler() {
  if (!config.outreach.enabled || !config.outreach.schedulerEnabled) {
    console.log('Outreach scheduler disabled.');
    return;
  }

  const intervalMs = Math.max(config.outreach.schedulerIntervalMs, 1000 * 60);
  const tick = async () => {
    if (outreachSchedulerRunning) {
      return;
    }

    outreachSchedulerRunning = true;

    try {
      const result = await sendDueOutreachMessages();
      console.log(
        `Outreach scheduler checked ${result.count || 0} due messages; sent ${result.sent?.length || 0}, blocked/failed ${result.failed?.length || 0}.`,
      );
    } catch (error) {
      console.error('Outreach scheduler failed:', error);
    } finally {
      outreachSchedulerRunning = false;
    }
  };

  setTimeout(tick, 1000 * 30).unref?.();
  setInterval(tick, intervalMs).unref?.();
  console.log(`Outreach scheduler enabled; interval ${intervalMs}ms.`);
}

app.listen(config.server.port, host, () => {
  console.log(`Uckele Group backend listening on ${host}:${config.server.port}`);
  startOutreachScheduler();
});
