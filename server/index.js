import 'dotenv/config';
import { createApp } from './app.js';
import { assertValidConfig, getConfig } from './config.js';
import {
  startDealHunterCimFollowUpScheduler,
  startDealHunterCimStage2Scheduler,
  startDealHunterDailyEmailScheduler,
} from './services/dealHunterScheduler.js';
import { reconcileSecureDocumentCleanupJobs, startSecureDocumentCleanupScheduler } from './services/submissions.js';
import { startBackupScheduler } from './services/backups.js';
import { cleanupExpiredAuthRecords, startAuthCleanupScheduler } from './services/auth.js';
import { startInboundCommunicationIngestionScheduler } from './services/communications.js';
import { initializeP10bRuntimeFilesystem, isP10bQualificationRuntime,
  runServerStartupMaintenance, startServerSchedulers } from './services/p10bRuntime.js';
import { installP10bIngressClosure } from './services/p10bIngressClosure.js';
import { closeCachedStorage } from './storage/index.js';
import fs from 'node:fs';

const config = getConfig();
const host = process.env.HOST || '0.0.0.0';
let schedulers = [];

assertValidConfig(config);
if (isP10bQualificationRuntime(config)) initializeP10bRuntimeFilesystem(config);
const app = createApp();
const cleanupSummary = await runServerStartupMaintenance(config, {
  cleanupAuth: cleanupExpiredAuthRecords, cleanupDocuments: reconcileSecureDocumentCleanupJobs,
});
if (cleanupSummary.reviewed > 0) {
  console.log(`[secure-documents:cleanup] startup reconciliation reviewed=${cleanupSummary.reviewed} completed=${cleanupSummary.completed} restored=${cleanupSummary.restored} failed=${cleanupSummary.failed}`);
}

const server = app.listen(config.server.port, host, () => {
  console.log(`Uckele Group backend listening on ${host}:${config.server.port}`);
  if (isP10bQualificationRuntime(config)) installP10bIngressClosure({ config, server,
    closeStorage: closeCachedStorage, runtime: { app: process.env.FLY_APP_NAME,
      machineId: process.env.FLY_MACHINE_ID, sourceHead: fs.readFileSync('/app/p10b-source-head.txt', 'utf8').trim() } });
  schedulers = startServerSchedulers(config, [
    startDealHunterDailyEmailScheduler,
    startDealHunterCimStage2Scheduler,
    startDealHunterCimFollowUpScheduler,
    startSecureDocumentCleanupScheduler,
    startBackupScheduler,
    startAuthCleanupScheduler,
    startInboundCommunicationIngestionScheduler,
  ]);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received; stopping schedulers and HTTP server`);
  schedulers.forEach((scheduler) => scheduler.stop());
  server.close((error) => {
    if (error) {
      console.error(`[server] shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  });

  const forceExitTimer = setTimeout(() => {
    console.error('[server] graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
