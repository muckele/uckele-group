import { defineConfig, devices } from '@playwright/test';
import { appOrigin, appPort } from './test-browser/app-origin.js';

export default defineConfig({
  testDir: './test-browser',
  fullyParallel: true,
  timeout: 30_000,
  use: {
    baseURL: appOrigin,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${appPort} --strictPort`,
    port: appPort,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
