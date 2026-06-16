import 'dotenv/config';
import { app } from './app.js';
import { getConfig } from './config.js';
import { startDealHunterCimFollowUpScheduler, startDealHunterDailyEmailScheduler } from './services/dealHunterScheduler.js';
import { startProspectDiscoveryScheduler } from './services/prospectDiscoveryScheduler.js';

const config = getConfig();
const host = process.env.HOST || '0.0.0.0';

app.listen(config.server.port, host, () => {
  console.log(`Uckele Group backend listening on ${host}:${config.server.port}`);
  startDealHunterDailyEmailScheduler();
  startDealHunterCimFollowUpScheduler();
  startProspectDiscoveryScheduler();
});
