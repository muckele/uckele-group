import 'dotenv/config';
import { app } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();

app.listen(config.server.port, () => {
  console.log(`Uckele Group backend listening on port ${config.server.port}`);
});
