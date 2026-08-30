import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { getStorage } from './storage/index.js';
import {
  getAcquisitionCommandCenter,
  getSourceHealth,
  updateAcquisitionCommandCenterRecord,
} from './services/acquisitionCommandCenter.js';
import {
  getAdminAuthState,
  requireAdminAccess,
  getAdminSession,
  loginAdmin,
  logoutAdmin,
  requestAdminMagicLink,
  requireAdmin,
  revokeAllAdminSessions,
  verifyAdminMagicLink,
} from './services/auth.js';
import {
  createSecureUploadRequest,
  enforceSecureUploadBodyRateLimit,
  getSecureUploadJsonLimitBytes,
  getSecureUploadContext,
  getSecureDocumentDownload,
  deleteSecureDocument,
  revokeSecureUploadRequest,
  uploadSecureDocuments,
} from './services/documentVault.js';
import { recordEmailEventsFromWebhook } from './services/emailEvents.js';
import { getEmailReadiness } from './services/emailReadiness.js';
import { sendAdminEmailTestEmail } from './services/delivery.js';
import { checkReadiness } from './services/readiness.js';
import {
  previewOpportunityScoreRefresh,
  refreshOpportunityScores,
  requestOpportunityScoreRefresh,
} from './services/dealHunterScoreStore.js';
import {
  getTriageOpportunityDetail,
  listTriageQueue,
  setTriageOperatorDecision,
} from './services/dealHunterTriage.js';
import { setCurrentOperatorOpportunityFact } from './services/dealHunterOpportunityFacts.js';
import {
  dealHunterCrmSyncConfirmation,
  auditDealHunterCrmIntegrity,
  executeDealOsCrmReconciliation,
  previewDealOsCrmReconciliation,
  reviewDailyDeals,
  importDealOsExport,
  runCimStage2Automation,
  runDealHunterCimFollowUps,
  listDealHunterCimRequestHistory,
  retryDealHunterCimRequestWithCorrectedRecipient,
  sendDealHunterCimRequest,
  sendDealHunterReadyCimRequests,
  syncDealHunterHighFitsToCrm,
  validateCimReviewDecisions,
} from './services/dealHunter.js';
import { getDailyDealHunterJobStatus, runClaimedDailyDealHunterEmail } from './services/dealHunterScheduler.js';
import {
  createManualSubmission,
  enforceContactBodyRateLimit,
  exportDashboardSubmissionsCsv,
  getDashboardSubmission,
  listDashboardFollowUps,
  listDashboardSubmissions,
  submitContactLead,
  deleteDashboardSubmission,
  updateSubmissionWorkflow,
} from './services/submissions.js';
import { asyncRoute } from './utils/http.js';
import { safeCompareText } from './utils/security.js';
import { listCrmActivity, projectCrmActivityTimeline } from './services/activity.js';
import { getOperationsCenter, sanitizeViewerOperations } from './services/operations.js';
import {
  assignUnassignedCommunication,
  createManualCommunication,
  listCrmCommunications,
  listUnassignedCommunications,
} from './services/communications.js';
import {
  archiveLead,
  dismissDealHunterOpportunity,
  restoreDealHunterOpportunity,
  restoreLead,
} from './services/leadLifecycle.js';
import { recordAnalyticsEvent } from './services/analytics.js';
import {
  createCimStage2Activation,
  getCimAutomationStatus,
  recordCimResponseOutcome,
  recordCimReviewDecisions,
  setCimAutomationPaused,
} from './services/cimAutomation.js';
import {
  previewCrmFollowUpEmail,
  sendCrmFollowUpEmail,
} from './services/followUpEmail.js';
import { generateCrmFollowUpRecommendation } from './services/followUpRecommendations.js';
import {
  createAdminEmailSuppression,
  dismissCrmFollowUpRecommendation,
  getCrmFollowUpContext,
  getCrmFollowUpOutboxResult,
  liftAdminEmailSuppression,
} from './services/followUpWorkspace.js';
import { registerAdminOnboardingRoutes } from './routes/adminOnboarding.js';
import {
  createCimRecipientOverride,
  resolveCimIdentityException,
  setCimOutreachPaused,
} from './services/cimOpportunityIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.resolve(__dirname, '../dist');

function extractBearerSecret(request) {
  const authorization = String(request.headers.authorization || '');

  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  return String(request.headers['x-deal-hunter-secret'] || request.headers['x-cron-secret'] || '').trim();
}

function requireDealHunterCron(request, config) {
  const providedSecret = extractBearerSecret(request);

  return Boolean(config.dealHunter.cronSecret && providedSecret && safeCompareText(providedSecret, config.dealHunter.cronSecret));
}

function captureRawBody(request, _response, buffer) {
  request.rawBody = buffer.toString('utf8');
}

function jsonParserOptions(limit) {
  return {
    limit,
    verify: captureRawBody,
  };
}

function decodedHeader(request, name, maxLength = 500) {
  const raw = String(request.headers[name] || '').trim();
  if (!raw) return '';

  try {
    return decodeURIComponent(raw).replace(/[\r\n]/g, ' ').trim().slice(0, maxLength);
  } catch {
    return raw.replace(/[\r\n]/g, ' ').trim().slice(0, maxLength);
  }
}

function setProtectedResponseHeaders(_request, response, next) {
  response.setHeader('Cache-Control', 'no-store, private');
  response.setHeader('Pragma', 'no-cache');
  next();
}

function protectMutationOrigin(config) {
  return (request, response, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      next();
      return;
    }

    const origin = String(request.headers.origin || '').replace(/\/+$/, '');
    const expectedOrigin = String(config.server.origin || '').replace(/\/+$/, '');
    const fetchSite = String(request.headers['sec-fetch-site'] || '').toLowerCase();

    if ((origin && expectedOrigin && origin !== expectedOrigin) || fetchSite === 'cross-site') {
      response.status(403).json({ success: false, error: 'Cross-site request rejected.' });
      return;
    }

    next();
  };
}

async function auditAdminMutation(request, response, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    next();
    return;
  }

  const storage = getStorage();
  const initialSession = await getAdminSession(request);
  const eventBase = {
    request_id: request.id || '',
    method: request.method,
    path: String(request.originalUrl || request.path || '').slice(0, 500),
  };

  try {
    await storage.insertAdminAuditEvent({
      id: randomUUID(),
      created_at: new Date().toISOString(),
      ...eventBase,
      actor: initialSession?.username || 'anonymous',
      role: initialSession?.role || 'anonymous',
      status_code: 0,
      metadata: { state: 'started' },
    });
  } catch (error) {
    console.error(`[request:${request.id || 'unknown'}] admin audit prewrite failed: ${error.message}`);
    response.status(503).json({ success: false, error: 'Administrative audit storage is unavailable. No change was made.' });
    return;
  }

  response.once('finish', () => {
    const session = request.adminSession || initialSession;

    Promise.resolve(storage.insertAdminAuditEvent({
      id: randomUUID(),
      created_at: new Date().toISOString(),
      ...eventBase,
      actor: session?.username || 'anonymous',
      role: session?.role || 'anonymous',
      status_code: response.statusCode,
      metadata: { state: 'completed' },
    })).catch((error) => {
      console.warn(`[request:${request.id || 'unknown'}] admin audit completion write failed: ${error.message}`);
    });
  });

  next();
}

export function handleAppError(error, request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }

  const explicitStatus = Number(error?.status || error?.statusCode);
  const status = explicitStatus >= 400 && explicitStatus < 600 ? explicitStatus : 500;
  const message = status === 413
    ? 'Request body is too large.'
    : status === 400 && error?.expose
      ? 'Invalid request body.'
      : 'Something went wrong while processing the request.';

  if (status >= 500) {
    console.error(`[request:${request.id || 'unknown'}] request failed`, {
      name: String(error?.name || 'Error').slice(0, 100),
      code: String(error?.code || '').slice(0, 100),
      status,
    });
  } else {
    console.warn(`[request:${request.id || 'unknown'}] ${error?.message || error}`);
  }

  response.status(status).json({
    success: false,
    error: message,
  });
}

function publicSecureDocument(document) {
  return {
    id: document.id,
    created_at: document.created_at,
    document_type: document.document_type,
    original_name: document.original_name,
    mime_type: document.mime_type,
    size_bytes: document.size_bytes,
    note: document.note || '',
    nda_accepted_at: document.nda_accepted_at || '',
  };
}

function publicSecureUploadRequest(requestRecord) {
  return {
    id: requestRecord.id,
    created_at: requestRecord.created_at,
    updated_at: requestRecord.updated_at,
    email: requestRecord.email,
    contact_name: requestRecord.contact_name,
    status: requestRecord.status,
    expires_at: requestRecord.expires_at,
    nda_required: Boolean(requestRecord.nda_required),
    nda_accepted_at: requestRecord.nda_accepted_at || '',
    last_uploaded_at: requestRecord.last_uploaded_at || '',
    note: requestRecord.note || '',
    requested_documents: requestRecord.requested_documents || [],
    requested_checklist: requestRecord.requested_checklist || [],
    revoked_at: requestRecord.revoked_at || '',
    closed_at: requestRecord.closed_at || '',
    upload_batch_count: Number(requestRecord.upload_batch_count || 0),
  };
}

// Vite fingerprints everything it emits under /assets, so those URLs can never
// go stale: changing the content changes the filename. Entry documents are not
// fingerprinted, so they revalidate and a deploy is picked up immediately.
// Anything else in dist keeps serve-static's revalidating default.
// Compression is deliberately absent: the Fly proxy compresses at the edge for
// responses that do not already carry a Content-Encoding header.
export const immutableAssetCacheControl = `public, max-age=${365 * 24 * 60 * 60}, immutable`;
export const entryDocumentCacheControl = 'no-cache';

export function setStaticAssetHeaders(response, filePath) {
  const relativePath = path.relative(distDirectory, filePath);
  if (relativePath === 'assets' || relativePath.startsWith(`assets${path.sep}`)) {
    response.setHeader('Cache-Control', immutableAssetCacheControl);
    return;
  }
  if (path.extname(filePath).toLowerCase() === '.html') {
    response.setHeader('Cache-Control', entryDocumentCacheControl);
  }
}

// The reconciliation plan is executed whole server-side; the response only has
// to stay small enough to render, so item bounding belongs here rather than in
// the plan itself. `dealsByOpportunity` is an in-process carry-over.
const reconciliationPreviewItemLimit = 1000;

function boundedReconciliationPlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.items)) return plan;
  const { dealsByOpportunity: _carriedDeals, ...rest } = plan;
  return {
    ...rest,
    items: plan.items.slice(0, reconciliationPreviewItemLimit),
    itemsTruncated: plan.items.length > reconciliationPreviewItemLimit,
  };
}

function boundedReconciliationPreview(result) {
  if (!result || typeof result !== 'object') return result;
  const bounded = boundedReconciliationPlan(result);
  return bounded.preview && typeof bounded.preview === 'object'
    ? { ...bounded, preview: boundedReconciliationPlan(bounded.preview) }
    : bounded;
}

const fullBackfillScoreFailureError = 'Full-backfill scoring could not be completed. The prior current-triage set remains in force.';
const currentTriageReconciliationFailureError = 'Current-triage eligibility could not be reconciled. The prior current-triage set remains in force.';
const safeScoreRefreshErrors = new Set([
  'Durable opportunity scoring storage is unavailable.',
  'The canonical full-backfill review could not prove a complete authoritative opportunity set.',
  'Durable current-triage eligibility reconciliation is unavailable.',
  'Scoring is deferred until every required Google Sheet is healthy.',
]);

function scoreRefreshFailureStatus(scoreRefresh) {
  const status = Number(scoreRefresh?.status);
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

function scoreRefreshOperatorError(scoreRefresh) {
  const error = String(scoreRefresh?.error || '').replace(/\s+/g, ' ').trim();
  if (error.startsWith('Current-triage eligibility could not be reconciled:')) {
    return currentTriageReconciliationFailureError;
  }
  return safeScoreRefreshErrors.has(error) ? error : fullBackfillScoreFailureError;
}

function publicScoreRefreshResult(scoreRefresh) {
  if (!scoreRefresh || typeof scoreRefresh !== 'object') return null;
  const result = {
    counts: scoreRefresh.counts,
    ok: Boolean(scoreRefresh.ok),
  };
  if (scoreRefresh.ok !== false) return result;

  const status = Number(scoreRefresh.status);
  if (Number.isInteger(status) && status >= 100 && status < 600) result.status = status;
  result.error = scoreRefreshOperatorError(scoreRefresh);
  if (scoreRefresh.scoringDeferred === true) result.scoringDeferred = true;
  if (Array.isArray(scoreRefresh.missingMethods)) {
    result.missingMethods = scoreRefresh.missingMethods.slice(0, 25)
      .map((method) => String(method || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100))
      .filter(Boolean);
  }
  if (Array.isArray(scoreRefresh.authorityProblems)) {
    result.authorityProblems = scoreRefresh.authorityProblems.slice(0, 25)
      .map((problem) => String(problem || '').replace(/\s+/g, ' ').trim().slice(0, 200))
      .filter(Boolean);
  }
  if (Array.isArray(scoreRefresh.errors) && scoreRefresh.errors.length > 0) {
    result.errors = scoreRefresh.errors.slice(0, 100).map((item) => ({
      opportunityId: String(item?.opportunityId || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 160),
      error: 'Opportunity scoring failed.',
    }));
  }
  return result;
}

export function createApp() {
  const config = getConfig();
  const app = express();
  const dealOsRawParser = express.raw({
    type: () => true,
    limit: config.dealHunter.dealOsExportMaxPayloadBytes,
  });
  let activeSecureUploads = 0;

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const providedId = String(request.headers['x-request-id'] || '').trim();
    request.id = /^[A-Za-z0-9._-]{1,100}$/.test(providedId) ? providedId : randomUUID();
    response.setHeader('X-Request-ID', request.id);
    next();
  });
  app.use('/api/admin', setProtectedResponseHeaders);
  app.use('/api/admin', protectMutationOrigin(config));
  app.use('/api/admin', (request, response, next) => {
    auditAdminMutation(request, response, next).catch(next);
  });
  app.use('/api/secure-documents', setProtectedResponseHeaders);
  app.use('/api/secure-documents/upload', async (request, response, next) => {
    if (request.method !== 'POST') {
      next();
      return;
    }

    try {
      const result = await enforceSecureUploadBodyRateLimit(request);

      if (!result.ok) {
        response.status(result.status || 429).json({ success: false, error: result.error });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  });
  app.use('/api/secure-documents/upload', async (request, response, next) => {
    if (request.method !== 'POST') {
      next();
      return;
    }

    try {
      const token = String(request.headers['x-secure-upload-token'] || '').trim();
      const context = await getSecureUploadContext(token, { recoverStale: true });

      if (!context.ok) {
        response.status(400).json({ success: false, error: context.error });
        return;
      }

      if (!['awaiting-documents', 'open', 'partially-received'].includes(context.request.status)) {
        response.status(409).json({
          success: false,
          error: context.request.status === 'uploading'
            ? 'Documents are already being uploaded for this request. Please wait a few minutes before trying again.'
            : 'This secure document request is closed. Please ask for a new upload link before sending more files.',
        });
        return;
      }

      request.secureUploadToken = token;
      request.secureUploadContext = context;
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use('/api/secure-documents/upload', (request, response, next) => {
    if (request.method !== 'POST') {
      next();
      return;
    }

    if (activeSecureUploads >= config.secureDocuments.maxConcurrentUploads) {
      response.setHeader('Retry-After', '30');
      response.status(503).json({ success: false, error: 'Secure upload capacity is temporarily full. Please try again shortly.' });
      return;
    }

    activeSecureUploads += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeSecureUploads = Math.max(0, activeSecureUploads - 1);
      }
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  });
  app.use('/api/secure-documents/upload', express.json(jsonParserOptions(getSecureUploadJsonLimitBytes(config))));
  app.use('/api/contact', async (request, response, next) => {
    if (request.method !== 'POST') {
      next();
      return;
    }

    try {
      const result = await enforceContactBodyRateLimit(request);

      if (!result.ok) {
        response.status(result.status || 429).json({ success: false, error: result.error });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  });
  app.use('/api/contact', express.json(jsonParserOptions(config.protection.contactJsonLimit)));
  app.use('/api/analytics/events', express.json(jsonParserOptions('16kb')));
  app.use('/api/webhooks/resend', express.json(jsonParserOptions('1mb')));
  app.use('/api/admin/deal-hunter/deal-os-import', async (request, response, next) => {
    if (request.method !== 'POST') {
      next();
      return;
    }

    try {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      request.dealOsImportSession = session;
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use(
    '/api/admin/deal-hunter/deal-os-import',
    (request, response, next) => {
      if (request.method !== 'POST') {
        next();
        return;
      }
      dealOsRawParser(request, response, next);
    },
  );
  app.use(express.json(jsonParserOptions('512kb')));
  app.use(express.urlencoded({ extended: true, limit: '64kb' }));

  app.use((request, response, next) => {
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "connect-src 'self' https://challenges.cloudflare.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "frame-src https://challenges.cloudflare.com",
        "img-src 'self' data: blob:",
        "object-src 'none'",
        "script-src 'self' https://challenges.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      ].join('; '),
    );

    if (config.isProduction) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
    });
  });

  app.get(
    '/api/ready',
    asyncRoute(async (_request, response) => {
      const readiness = await checkReadiness();
      response.status(readiness.ok ? 200 : 503).json(readiness);
    }),
  );

  app.get('/api/public-config', (_request, response) => {
    response.json({
      success: true,
      turnstileSiteKey: config.turnstile.siteKey,
      turnstileEnabled: Boolean(config.turnstile.siteKey && config.turnstile.secretKey),
    });
  });

  app.post(
    '/api/analytics/events',
    asyncRoute(async (request, response) => {
      const result = await recordAnalyticsEvent(request.body || {}, request);

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }

      response.status(202).json({ success: true });
    }),
  );

  app.post(
    '/api/contact',
    asyncRoute(async (request, response) => {
      const result = await submitContactLead(request.body || {}, request);
      response.status(result.status).json(result.body);
    }),
  );

  app.post(
    '/api/webhooks/resend',
    asyncRoute(async (request, response) => {
      const result = await recordEmailEventsFromWebhook(request);

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }

      response.status(result.status || 201).json({
        success: true,
        count: result.events.length,
      });
    }),
  );

  app.get('/api/admin/session', asyncRoute(async (request, response) => {
    const session = await getAdminSession(request);

    response.json({
      authenticated: Boolean(session),
      username: session?.username || '',
      role: session?.role || '',
      ...getAdminAuthState(),
    });
  }));

  app.post(
    '/api/admin/session',
    asyncRoute(async (request, response) => {
      const result = await loginAdmin(request.body?.username || '', request.body?.password || '', request);

      if (!result.ok) {
        response.status(result.status || 401).json({ success: false, error: result.reason });
        return;
      }

      request.adminSession = result.session;
      response.setHeader('Set-Cookie', result.cookie);
      response.json({
        success: true,
        username: result.session.username,
        role: result.session.role,
      });
    }),
  );

  app.post(
    '/api/admin/magic-link/request',
    asyncRoute(async (request, response) => {
      const result = await requestAdminMagicLink(request.body?.email || '', request);

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.reason });
        return;
      }

      response.json({
        success: true,
        message: result.message,
        previewUrl: result.previewUrl || '',
      });
    }),
  );

  app.post('/api/admin/magic-link/verify', asyncRoute(async (request, response) => {
    const result = await verifyAdminMagicLink(request.body?.token || '');

    if (!result.ok) {
      response.status(401).json({ success: false, error: result.reason });
      return;
    }

    request.adminSession = result.session;
    response.setHeader('Set-Cookie', result.cookie);
    response.json({
      success: true,
      username: result.session.username,
      role: result.session.role,
    });
  }));

  app.delete('/api/admin/session', asyncRoute(async (request, response) => {
    response.setHeader('Set-Cookie', await logoutAdmin(request));
    response.json({ success: true });
  }));

  app.post('/api/admin/sessions/revoke-all', asyncRoute(async (request, response) => {
    const result = await revokeAllAdminSessions(request);
    if (!result.ok) {
      response.status(result.status || 401).json({ success: false, error: result.reason });
      return;
    }
    response.setHeader('Set-Cookie', result.cookie);
    response.json({ success: true, revoked: result.revoked });
  }));

  registerAdminOnboardingRoutes(app);

  app.get(
    '/api/admin/acquisition-command-center',
    asyncRoute(async (request, response) => {
      const session = await requireAdminAccess(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const commandCenter = await getAcquisitionCommandCenter({
        persistSourceHealth: session.role === 'admin',
      });
      response.json({
        success: true,
        commandCenter,
      });
    }),
  );

  app.get(
    '/api/admin/operations',
    asyncRoute(async (request, response) => {
      const session = await requireAdminAccess(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Authenticated admin access is required.' });
        return;
      }

      const operations = await getOperationsCenter();
      response.json({
        success: true,
        operations: session.role === 'viewer' ? sanitizeViewerOperations(operations) : operations,
      });
    }),
  );

  app.post(
    '/api/admin/email/test',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const readiness = await getEmailReadiness();
      const requestedRecipient = String(request.body?.recipient || readiness.testRecipient || '').trim().toLowerCase();
      const allowedRecipient = readiness.allowedTestRecipients.includes(requestedRecipient);

      if (!readiness.outboundConfigured) {
        response.status(409).json({ success: false, error: 'Resend outbound delivery is not fully configured.', readiness });
        return;
      }

      if (!requestedRecipient || !allowedRecipient) {
        response.status(400).json({
          success: false,
          error: 'Test emails may only be sent to a configured internal administrator address.',
          readiness,
        });
        return;
      }

      const emailResult = await sendAdminEmailTestEmail({
        to: requestedRecipient,
        requestedBy: session.username || 'admin',
      });
      const refreshedReadiness = await getEmailReadiness();
      response.status(emailResult.status === 'failed' ? 502 : 201).json({
        success: emailResult.status !== 'failed',
        emailResult,
        readiness: refreshedReadiness,
      });
    }),
  );

  app.post(
    '/api/admin/acquisition-command-center/:id',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await updateAcquisitionCommandCenterRecord({
        submissionId: request.params.id,
        pipelineStage: request.body?.pipelineStage || '',
        passReason: request.body?.passReason || '',
        fitFeedback: request.body?.fitFeedback || '',
        feedbackNote: request.body?.feedbackNote || '',
        updatedBy: session.username || 'admin',
      });

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }

      response.json({
        success: true,
        ...result,
      });
    }),
  );

  app.get(
    '/api/admin/submissions',
    asyncRoute(async (request, response) => {
      if (!await requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await listDashboardSubmissions({
        page: Number(request.query.page) || 1,
        pageSize: Number(request.query.pageSize) || 25,
        search: String(request.query.search || ''),
        status: String(request.query.status || 'all'),
        created: String(request.query.created || 'all'),
        sort: String(request.query.sort || 'created_at'),
        direction: String(request.query.direction || 'desc'),
      });

      response.json({
        success: true,
        ...result,
      });
    }),
  );

  app.get(
    '/api/admin/follow-ups',
    asyncRoute(async (request, response) => {
      if (!await requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await listDashboardFollowUps({
        page: Number(request.query.page) || 1,
        pageSize: Number(request.query.pageSize) || 25,
        search: String(request.query.search || ''),
        view: String(request.query.view || 'crm-actions'),
        sort: String(request.query.sort || 'urgency'),
        direction: String(request.query.direction || 'desc'),
      });

      response.json({
        success: true,
        ...result,
      });
    }),
  );

  app.get(
    '/api/admin/follow-ups/:submissionId/context',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(403).json({ success: false, error: 'Administrator access is required to read email contents.' });
        return;
      }
      const result = await getCrmFollowUpContext({
        submissionId: request.params.submissionId,
        communicationPage: Number(request.query.communicationPage) || 1,
        communicationPageSize: Number(request.query.communicationPageSize) || 50,
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/follow-ups/:submissionId/recommendations',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await generateCrmFollowUpRecommendation({
        submissionId: request.params.submissionId,
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/follow-ups/:submissionId/email-preview',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await previewCrmFollowUpEmail({
        submissionId: request.params.submissionId,
        actor: session.username || 'admin',
        input: request.body || {},
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/follow-ups/:submissionId/send-email',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await sendCrmFollowUpEmail({
        submissionId: request.params.submissionId,
        actor: session.username || 'admin',
        input: request.body || {},
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.get(
    '/api/admin/follow-ups/:submissionId/outbox/:outboxId',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await getCrmFollowUpOutboxResult({
        submissionId: request.params.submissionId,
        outboxId: request.params.outboxId,
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/follow-ups/:submissionId/workflow',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      if (typeof request.body?.action !== 'string') {
        response.status(400).json({ success: false, error: 'Action must be pursue, watch, or pass.' });
        return;
      }
      const action = request.body.action.trim().toLowerCase();
      const expectedUpdatedAt = String(request.body?.expectedSubmissionVersion || request.body?.expected_updated_at || '');
      let fields;
      if (action === 'snooze' || action === 'reschedule') {
        if (!Number.isFinite(Date.parse(request.body?.nextActionAt || ''))) {
          response.status(422).json({ success: false, error: 'A valid next action time is required.' });
          return;
        }
        fields = {
          expected_updated_at: expectedUpdatedAt,
          follow_up_state: 'scheduled',
          next_action_at: new Date(request.body.nextActionAt).toISOString(),
        };
      } else if (action === 'complete') {
        fields = { expected_updated_at: expectedUpdatedAt, follow_up_state: 'completed', next_action_at: null };
      } else if (action === 'reopen') {
        fields = {
          expected_updated_at: expectedUpdatedAt,
          follow_up_state: 'needs-response',
          next_action_at: Number.isFinite(Date.parse(request.body?.nextActionAt || ''))
            ? new Date(request.body.nextActionAt).toISOString()
            : new Date().toISOString(),
        };
      } else {
        response.status(422).json({ success: false, error: 'Choose snooze, reschedule, complete, or reopen.' });
        return;
      }
      const submission = await updateSubmissionWorkflow(request.params.submissionId, fields, {
        actor: session.username || 'admin',
        role: 'admin',
      });
      if (submission?.conflict) {
        response.status(409).json({ success: false, error: 'The CRM record changed. Refresh and try again.', ...submission });
        return;
      }
      if (!submission) {
        response.status(422).json({ success: false, error: 'The CRM workflow action could not be applied.' });
        return;
      }
      response.json({ success: true, submission });
    }),
  );

  app.post(
    '/api/admin/follow-ups/:submissionId/recommendations/:recommendationId/dismiss',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await dismissCrmFollowUpRecommendation({
        submissionId: request.params.submissionId,
        recommendationId: request.params.recommendationId,
        expectedSubmissionVersion: String(request.body?.expectedSubmissionVersion || ''),
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/follow-ups/:submissionId/suppressions',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await createAdminEmailSuppression({
        submissionId: request.params.submissionId,
        email: request.body?.email || '',
        reason: request.body?.reason || '',
        confirmed: request.body?.confirmed === true,
        overrideReason: request.body?.overrideReason || '',
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 201 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/follow-ups/:submissionId/suppressions/lift',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(403).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await liftAdminEmailSuppression({
        submissionId: request.params.submissionId,
        email: request.body?.email || '',
        liftReason: request.body?.liftReason || '',
        confirmed: request.body?.confirmed === true,
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/submissions',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await createManualSubmission(request.body || {}, session.username);

      if (!result.ok) {
        response.status(result.status || 400).json({
          success: false,
          errors: result.errors || ['Unable to create the CRM record.'],
        });
        return;
      }

      response.status(result.status || 201).json({
        success: true,
        submission: result.submission,
      });
    }),
  );

  app.get(
    '/api/admin/submissions/export',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const csv = await exportDashboardSubmissionsCsv();
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="uckele-group-submissions.csv"');
      response.send(csv);
    }),
  );

  app.get(
    '/api/admin/submissions/:id',
    asyncRoute(async (request, response) => {
      if (!await requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const submission = await getDashboardSubmission(request.params.id);

      if (!submission) {
        response.status(404).json({ success: false, error: 'CRM record not found.' });
        return;
      }

      response.json({
        success: true,
        submission,
      });
    }),
  );

  app.get(
    '/api/admin/submissions/:id/activity',
    asyncRoute(async (request, response) => {
      if (!await requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const submission = await getDashboardSubmission(request.params.id);
      if (!submission) {
        response.status(404).json({ success: false, error: 'CRM record not found.' });
        return;
      }

      const eventTypes = String(request.query.types || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const events = await listCrmActivity({
        submissionId: request.params.id,
        eventTypes,
        limit: Number(request.query.limit) || 200,
        before: String(request.query.before || ''),
      });
      const timeline = projectCrmActivityTimeline(events);
      response.json({ success: true, events: timeline.events, rawEvents: events, counts: timeline.counts });
    }),
  );

  app.get(
    '/api/admin/submissions/:id/communications',
    asyncRoute(async (request, response) => {
      if (!await requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const submission = await getDashboardSubmission(request.params.id);
      if (!submission) {
        response.status(404).json({ success: false, error: 'CRM record not found.' });
        return;
      }

      const result = await listCrmCommunications({
        submissionId: submission.id,
        page: Number(request.query.page) || 1,
        pageSize: Number(request.query.pageSize) || 25,
        before: String(request.query.before || ''),
      });
      response.json({ success: true, communications: result.rows || [], ...result });
    }),
  );

  app.post(
    '/api/admin/submissions/:id/communications',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const result = await createManualCommunication({
        submissionId: request.params.id,
        input: request.body || {},
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 201 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.get(
    '/api/admin/communications/unassigned',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const result = await listUnassignedCommunications({
        page: Number(request.query.page) || 1,
        pageSize: Number(request.query.pageSize) || 25,
      });
      response.json({ success: true, communications: result.rows || [], ...result });
    }),
  );

  app.patch(
    '/api/admin/communications/:id/assign',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const result = await assignUnassignedCommunication({
        communicationId: request.params.id,
        submissionId: request.body?.submissionId || request.body?.submission_id || '',
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.get(
    '/api/admin/deal-hunter/review',
    asyncRoute(async (request, response) => {
      const session = await requireAdminAccess(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const review = await reviewDailyDeals();
      review.dailyEmailJob = await getDailyDealHunterJobStatus();
      review.emailReadiness = await getEmailReadiness();
      await getSourceHealth(undefined, {
        persistSnapshot: session.role === 'admin',
        refresh: true,
        review,
      });
      response.json({
        success: true,
        review,
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/deal-os-import',
    asyncRoute(async (request, response) => {
      const session = request.dealOsImportSession || await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const requestedReviewMode = decodedHeader(request, 'x-deal-os-review-mode', 40) || 'daily';
      if (!['daily', 'full-backfill'].includes(requestedReviewMode)) {
        response.status(400).json({ success: false, error: 'Deal OS review mode must be daily or full-backfill.' });
        return;
      }

      const result = await importDealOsExport({
        fileBuffer: request.body,
        fileName: decodedHeader(request, 'x-deal-os-file-name', 180),
        mimeType: String(request.headers['content-type'] || '').slice(0, 160),
        exportedAt: decodedHeader(request, 'x-deal-os-exported-at', 100),
        scope: decodedHeader(request, 'x-deal-os-scope', 40),
        coverageLabel: decodedHeader(request, 'x-deal-os-coverage-label', 200),
        expectedRowCount: decodedHeader(request, 'x-deal-os-expected-row-count', 20),
        importedBy: session.username || 'admin',
      });

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error, details: result.details || [] });
        return;
      }

      let review = null;
      let reviewWarning = '';
      let scoreRefresh = null;
      try {
        const reviewed = await reviewDailyDeals({ reviewMode: requestedReviewMode, withScoredDeals: true });
        review = reviewed.review;
        review.dailyEmailJob = await getDailyDealHunterJobStatus();
        review.emailReadiness = await getEmailReadiness();
        if (review.scoringDeferred) {
          reviewWarning = 'The export was imported and retained, but scoring is deferred until every required Google Sheet is healthy.';
        } else {
          // Persist scores for the listings this import produced. Fingerprint
          // gating means unchanged opportunities cost nothing.
          scoreRefresh = await refreshOpportunityScores({ deals: reviewed.scoredDeals, actor: session.username || 'admin' });
        }
      } catch (error) {
        reviewWarning = `The export was imported, but scoring could not be refreshed: ${error.message}`;
      }

      response.status(201).json({
        success: true,
        import: result.import,
        review,
        scoreRefresh: scoreRefresh ? { counts: scoreRefresh.counts, ok: scoreRefresh.ok } : null,
        summary: review?.importSummary || {
          importId: result.import?.id || '',
          reviewMode: requestedReviewMode,
          importedRows: Number(result.import?.acceptedRowCount ?? result.import?.rowCount ?? 0),
          sourceRows: Number(result.import?.sourceRowCount ?? result.import?.rowCount ?? 0),
          rejectedRows: Number(result.import?.rejectedRowCount || 0),
          canonicalImportRecords: Number(result.import?.canonicalRecordCount ?? result.import?.rowCount ?? 0),
          withinFileDuplicates: Number(result.import?.duplicateCount || 0),
          fieldCoverage: result.import?.fieldCoverage || { totalRecords: 0, fields: [] },
        },
        ...(reviewWarning ? { reviewWarning } : {}),
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/backfill-review',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const reviewed = await reviewDailyDeals({ reviewMode: 'full-backfill', withScoredDeals: true });
      const review = reviewed.review;
      review.dailyEmailJob = await getDailyDealHunterJobStatus();
      review.emailReadiness = await getEmailReadiness();
      await getSourceHealth(undefined, { persistSnapshot: true, refresh: true, review });
      const reviewWarning = review.scoringDeferred
        ? 'Full-backfill scoring is deferred until every required Google Sheet is healthy. Existing persisted scores were left unchanged.'
        : '';
      const scoreRefresh = review.scoringDeferred
        ? null
        : await refreshOpportunityScores({
            actor: session.username || 'admin',
          });
      if (scoreRefresh?.scoringDeferred === true) {
        const deferredReview = {
          ...(scoreRefresh.review && typeof scoreRefresh.review === 'object' ? scoreRefresh.review : review),
          dailyEmailJob: review.dailyEmailJob,
          emailReadiness: review.emailReadiness,
        };
        response.json({
          success: true,
          review: deferredReview,
          summary: deferredReview.importSummary,
          scoreRefresh: null,
          reviewWarning: 'Full-backfill scoring is deferred until every required Google Sheet is healthy. Existing persisted scores were left unchanged.',
        });
        return;
      }
      const publicScoreRefresh = publicScoreRefreshResult(scoreRefresh);
      if (scoreRefresh?.ok === false) {
        response.status(scoreRefreshFailureStatus(scoreRefresh)).json({
          success: false,
          error: publicScoreRefresh.error,
          scoreRefresh: publicScoreRefresh,
        });
        return;
      }
      response.json({
        success: true,
        review,
        summary: review.importSummary,
        scoreRefresh: publicScoreRefresh,
        ...(reviewWarning ? { reviewWarning } : {}),
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/crm-reconciliation/preview',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await previewDealOsCrmReconciliation({
        importId: request.body?.importId || '',
        requestedBy: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400))
        .json({ success: Boolean(result.ok), ...boundedReconciliationPreview(result) });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/crm-reconciliation/execute',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await executeDealOsCrmReconciliation({
        importId: request.body?.importId || '',
        planDigest: request.body?.planDigest || '',
        previewGeneratedAt: request.body?.previewGeneratedAt || '',
        expectedOpportunityIds: request.body?.expectedOpportunityIds || [],
        confirmation: request.body?.confirmation || '',
        requestedBy: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400))
        .json({ success: Boolean(result.ok), ...boundedReconciliationPreview(result) });
    }),
  );

  app.get(
    '/api/admin/deal-hunter/crm-integrity-audit',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const audit = await auditDealHunterCrmIntegrity();
      response.status(audit.ok ? 200 : 409).json({ success: audit.ok, audit });
    }),
  );

  app.get(
    '/api/admin/deal-hunter/triage',
    asyncRoute(async (request, response) => {
      // Read-only viewers may inspect the queue, matching adjacent Deal Hunter
      // read routes. Only full administrators can record a decision.
      const session = await requireAdminAccess(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Authenticated admin access is required.' });
        return;
      }
      const result = await listTriageQueue({
        view: request.query.view,
        page: request.query.page,
        pageSize: request.query.pageSize,
        search: request.query.search,
        sort: request.query.sort,
        direction: request.query.direction,
        minScore: request.query.minScore,
        confidence: request.query.confidence,
        priority: request.query.priority,
        state: request.query.state,
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.get(
    '/api/admin/deal-hunter/triage/:opportunityId',
    asyncRoute(async (request, response) => {
      const session = await requireAdminAccess(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Authenticated admin access is required.' });
        return;
      }
      const result = await getTriageOpportunityDetail({ opportunityId: request.params.opportunityId });
      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error || 'Opportunity detail is unavailable.' });
        return;
      }
      const { ok: _ok, status: _status, ...detail } = result;
      response.status(200).json(detail);
    }),
  );

  app.put(
    '/api/admin/deal-hunter/opportunities/:opportunityId/facts/:field',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      if (typeof request.body?.verified !== 'boolean') {
        response.status(400).json({ success: false, error: 'Opportunity fact verification state must be boolean.' });
        return;
      }
      try {
        const fact = await setCurrentOperatorOpportunityFact({
          opportunityId: request.params.opportunityId,
          field: request.params.field,
          value: request.body?.value,
          verified: request.body.verified,
          note: request.body?.note ?? null,
          actor: session.username || 'admin',
          storage: getStorage(),
        });
        response.status(200).json({ success: true, fact });
      } catch (error) {
        const message = String(error?.message || 'Opportunity fact could not be saved.');
        const status = /no longer current|current canonical opportunity/i.test(message) ? 409 : /was not found/i.test(message) ? 404 : 400;
        response.status(status).json({ success: false, error: message });
      }
    }),
  );

  app.post(
    '/api/admin/deal-hunter/triage/:opportunityId/decision',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await setTriageOperatorDecision({
        opportunityId: request.params.opportunityId,
        priority: request.body?.priority,
        note: request.body?.note,
        markReviewed: Boolean(request.body?.markReviewed),
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/triage/:opportunityId/action',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const action = String(request.body?.action || '').trim().toLowerCase();
      if (!['pursue', 'watch', 'pass'].includes(action)) {
        response.status(400).json({ success: false, error: 'Action must be pursue, watch, or pass.' });
        return;
      }
      const opportunityId = request.params.opportunityId;
      if (action === 'pursue' || action === 'watch') {
        const result = await setTriageOperatorDecision({
          opportunityId,
          priority: action === 'pursue' ? 'high' : 'watch',
          markReviewed: true,
          actor: session.username || 'admin',
        });
        response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), action, ...result });
        return;
      }

      const storage = getStorage();
      const [opportunity, score] = await Promise.all([
        storage.getCurrentDealHunterOpportunity?.(opportunityId),
        storage.getCurrentDealHunterOpportunityScore?.(opportunityId),
      ]);
      if (!opportunity || !score) {
        response.status(404).json({ success: false, error: 'No current score has been recorded for this opportunity.' });
        return;
      }
      const reason = request.body?.reason;
      const note = request.body?.note;
      if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 80) {
        response.status(400).json({ success: false, error: 'A bounded disposition reason is required.' });
        return;
      }
      if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 2000)) {
        response.status(400).json({ success: false, error: 'Disposition note must be a bounded string.' });
        return;
      }
      const dismissal = await dismissDealHunterOpportunity({
        dealKey: score.deal_key || '',
        listingUrl: score.listing_url || '',
        dealName: score.name || opportunity.canonical_name || '',
        reason: reason.trim(),
        note: note?.trim() || '',
        submissionId: opportunity.primary_submission_id || '',
        actor: session.username || 'admin',
        storage,
      });
      if (!dismissal.ok) {
        response.status(dismissal.status || 400).json({ success: false, action, ...dismissal });
        return;
      }
      const review = await setTriageOperatorDecision({
        opportunityId,
        markReviewed: true,
        actor: session.username || 'admin',
        storage,
      });
      response.status(review.status || (review.ok ? 200 : 400)).json({
        success: Boolean(review.ok), action, disposition: dismissal.disposition || null, ...review,
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/scores/refresh/preview',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      // Read-only: reports what a refresh would change without writing.
      const requestedIds = Array.isArray(request.body?.opportunityIds) ? request.body.opportunityIds.slice(0, 1000) : [];
      const result = await previewOpportunityScoreRefresh({ opportunityIds: requestedIds });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/scores/refresh',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const requestedIds = Array.isArray(request.body?.opportunityIds) ? request.body.opportunityIds.slice(0, 1000) : [];
      const result = await requestOpportunityScoreRefresh({
        opportunityIds: requestedIds,
        force: Boolean(request.body?.force),
        confirmation: request.body?.confirmation || '',
        requestedBy: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/crm-sync',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const reviewMode = String(request.body?.reviewMode || 'daily');
      if (!['daily', 'full-backfill'].includes(reviewMode)) {
        response.status(400).json({ success: false, error: 'CRM sync review mode must be daily or full-backfill.' });
        return;
      }

      const result = await syncDealHunterHighFitsToCrm({
        confirmation: request.body?.confirmation || '',
        expectedDealKeys: request.body?.expectedDealKeys || [],
        requestedBy: session.username || 'admin',
        reviewMode,
      });
      if (result.review) {
        result.review.dailyEmailJob = await getDailyDealHunterJobStatus();
        result.review.emailReadiness = await getEmailReadiness();
      }
      response.status(result.status || (result.ok ? 200 : 400)).json({
        success: Boolean(result.ok),
        confirmationRequired: dealHunterCrmSyncConfirmation,
        ...result,
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/send',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await runClaimedDailyDealHunterEmail({ triggeredBy: session.username || 'admin' });
      if (result.review) {
        result.review.dailyEmailJob = result.jobRun || await getDailyDealHunterJobStatus();
        result.review.emailReadiness = await getEmailReadiness();
      }
      response.status(result.emailResult.status === 'failed' ? 502 : result.inProgress ? 409 : 200).json({
        success: !['failed', 'in-progress'].includes(result.emailResult.status),
        ...result,
      });
    }),
  );

  app.get(
    '/api/admin/deal-hunter/cim-requests',
    asyncRoute(async (request, response) => {
      if (!await requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await listDealHunterCimRequestHistory({
        page: Number(request.query.page) || 1,
        pageSize: Number(request.query.pageSize) || 25,
        search: String(request.query.search || ''),
        requestState: String(request.query.requestState || request.query.request_state || ''),
        deliveryState: String(request.query.deliveryState || request.query.delivery_state || ''),
        replyState: String(request.query.replyState || request.query.reply_state || ''),
        followUpState: String(request.query.followUpState || request.query.follow_up_state || ''),
        sort: String(request.query.sort || 'first_requested_at'),
        direction: String(request.query.direction || 'desc'),
      });
      response.json({ success: true, requests: result.rows || [], ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-requests/:id/retry',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const result = await retryDealHunterCimRequestWithCorrectedRecipient({
        requestId: request.params.id,
        newRecipientEmail: request.body?.newRecipientEmail || request.body?.recipientEmail || '',
        confirmed: request.body?.confirmed === true,
        overrideReason: request.body?.overrideReason || '',
        requestedBy: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 201 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/dispositions',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const action = String(request.body?.action || 'dismiss').toLowerCase();
      const result = action === 'restore'
        ? await restoreDealHunterOpportunity({
            dealKey: request.body?.dealKey || '',
            actor: session.username || 'admin',
          })
        : await dismissDealHunterOpportunity({
            dealKey: request.body?.dealKey || '',
            listingUrl: request.body?.listingUrl || '',
            dealName: request.body?.dealName || '',
            reason: request.body?.reason || '',
            note: request.body?.note || '',
            submissionId: request.body?.submissionId || '',
            actor: session.username || 'admin',
          });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-request',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await sendDealHunterCimRequest({
        dealKey: request.body?.dealKey || '',
        snapshotToken: request.body?.snapshotToken || request.body?.deal?.cimRequest?.snapshotToken || '',
        requestedBy: session.username || 'admin',
      });

      response.status(result.status || (result.ok ? 200 : 400)).json({
        success: Boolean(result.ok),
        ...result,
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-requests/send-ready',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await sendDealHunterReadyCimRequests({
        requestedBy: session.username || 'admin',
        limit: request.body?.limit,
        selections: request.body?.selections,
      });

      response.status(result.status || (result.ok ? 200 : 400)).json({
        success: Boolean(result.ok),
        ...result,
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-reviews',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const validated = validateCimReviewDecisions(request.body?.decisions);
      if (!validated.valid) {
        response.status(400).json({ success: false, error: validated.error });
        return;
      }
      const status = await getCimAutomationStatus();
      const reviews = await recordCimReviewDecisions({
        decisions: validated.decisions,
        actor: session.username || 'admin',
        actorRole: session.role || 'admin',
        stage: status.effectiveStage,
        source: 'approval-queue',
      });
      response.status(201).json({ success: true, recorded: reviews.length, automation: await getCimAutomationStatus() });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-automation/pause',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      if (typeof request.body?.paused !== 'boolean') {
        response.status(400).json({ success: false, error: 'A boolean paused value is required.' });
        return;
      }
      try {
        await setCimAutomationPaused({
          paused: request.body.paused,
          actor: session.username || 'admin',
          reason: request.body?.reason || '',
        });
        response.json({ success: true, automation: await getCimAutomationStatus() });
      } catch (error) {
        response.status(400).json({ success: false, error: error.message || 'The automation pause change was rejected.' });
      }
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-stage2/activation',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      try {
        const activation = await createCimStage2Activation({
          mode: request.body?.mode,
          confirmation: request.body?.confirmation,
          actor: session.username || 'admin',
          reason: request.body?.reason,
          evidenceChecksum: request.body?.evidenceChecksum || request.body?.evidence_checksum,
          evidenceGeneratedAt: request.body?.evidenceGeneratedAt || request.body?.evidence_generated_at,
          backupReference: request.body?.backupReference || request.body?.backup_reference,
          backupChecksum: request.body?.backupChecksum || request.body?.backup_checksum,
          identityAuditReference: request.body?.identityAuditReference || request.body?.identity_audit_reference,
          identityAuditChecksum: request.body?.identityAuditChecksum || request.body?.identity_audit_checksum,
          complianceReference: request.body?.complianceReference || request.body?.compliance_reference,
          senderAuthReference: request.body?.senderAuthReference || request.body?.sender_auth_reference,
        });
        response.status(201).json({ success: true, activation, automation: await getCimAutomationStatus() });
      } catch (error) {
        response.status(400).json({ success: false, error: error.message || 'Stage 2 activation was rejected.' });
      }
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-stage2/run',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const mode = String(request.body?.mode || 'shadow').toLowerCase();
      if (mode === 'active') {
        response.status(400).json({ success: false, error: 'Active-mode runs are not available from this rollout endpoint.' });
        return;
      }
      if (mode === 'canary' && request.body?.confirmation !== 'RUN CIM STAGE 2 CANARY') {
        response.status(400).json({ success: false, error: 'Enter the exact confirmation phrase: RUN CIM STAGE 2 CANARY' });
        return;
      }
      const result = await runCimStage2Automation({ mode, triggeredBy: session.username || 'admin' });
      response.status(result.status || (result.ok ? 200 : 409)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.get(
    '/api/admin/deal-hunter/cim-stage2/runs/:id/decisions',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const page = Math.max(1, Math.min(Number.parseInt(request.query?.page, 10) || 1, 10));
      const pageSize = Math.max(1, Math.min(Number.parseInt(request.query?.pageSize, 10) || 50, 100));
      const start = (page - 1) * pageSize;
      const decisions = await getStorage().listCimStage2Decisions({
        runId: String(request.params.id || '').slice(0, 200),
        limit: pageSize + 1,
        offset: start,
      });
      response.json({
        success: true,
        page,
        pageSize,
        hasMore: decisions.length > pageSize,
        decisions: decisions.slice(0, pageSize),
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-outreach/pause',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      if (typeof request.body?.paused !== 'boolean') {
        response.status(400).json({ success: false, error: 'A boolean paused value is required.' });
        return;
      }
      const settings = await setCimOutreachPaused({
        paused: request.body.paused,
        actor: session.username || 'admin',
        reason: request.body?.reason || '',
      });
      response.json({ success: true, settings });
    }),
  );

  app.get(
    '/api/admin/deal-hunter/identity-exceptions',
    asyncRoute(async (request, response) => {
      if (!await requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }
      const storage = getStorage();
      const exceptions = await storage.listDealHunterIdentityExceptions?.({
        statuses: String(request.query.status || 'open') === 'all' ? [] : [String(request.query.status || 'open')],
        limit: Number(request.query.limit) || 100,
      }) || [];
      response.json({ success: true, exceptions });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/identity-exceptions/:id/resolve',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await resolveCimIdentityException({
        exceptionId: request.params.id,
        opportunityId: request.body?.opportunityId || '',
        action: request.body?.action || 'link',
        confirmed: request.body?.confirmed === true,
        reason: request.body?.reason || '',
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-recipient-overrides',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      const result = await createCimRecipientOverride({
        opportunityId: request.body?.opportunityId || '',
        recipientEmail: request.body?.recipientEmail || '',
        confirmed: request.body?.confirmed === true,
        reason: request.body?.reason || '',
        expiresInHours: request.body?.expiresInHours ?? 1,
        actor: session.username || 'admin',
      });
      response.status(result.status || (result.ok ? 201 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-outcomes',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }
      let outcome;
      try {
        outcome = await recordCimResponseOutcome({
          dealKey: request.body?.dealKey,
          outcome: request.body?.outcome,
          actor: session.username || 'admin',
        });
      } catch (error) {
        response.status(400).json({ success: false, error: error.message || 'A valid CIM response outcome is required.' });
        return;
      }
      response.status(201).json({ success: true, outcome });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-follow-ups/run',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await runDealHunterCimFollowUps({
        limit: Number(request.body?.limit) || undefined,
      });

      response.status(result.status || (result.ok ? 200 : 400)).json({
        success: Boolean(result.ok),
        ...result,
      });
    }),
  );

  app.post(
    '/api/deal-hunter/daily-email',
    asyncRoute(async (request, response) => {
      if (!requireDealHunterCron(request, config)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await runClaimedDailyDealHunterEmail({ triggeredBy: 'external-cron' });
      response.status(result.emailResult.status === 'failed' ? 502 : result.inProgress ? 409 : 200).json({
        success: !['failed', 'in-progress'].includes(result.emailResult.status),
        ...result,
      });
    }),
  );

  app.post(
    '/api/deal-hunter/cim-stage2/run',
    asyncRoute(async (request, response) => {
      if (!requireDealHunterCron(request, config)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }
      const mode = String(request.body?.mode || 'shadow').toLowerCase();
      if (!['shadow', 'canary'].includes(mode)) {
        response.status(400).json({ success: false, error: 'External Stage 2 runs are restricted to shadow or canary mode.' });
        return;
      }
      const result = await runCimStage2Automation({ mode, triggeredBy: 'external-stage2-cron' });
      response.status(result.status || (result.ok ? 200 : 409)).json({
        success: Boolean(result.ok),
        ok: Boolean(result.ok),
        status: result.status,
        error: result.error || '',
        blockerCodes: result.blockerCodes || [],
        providerCalls: Number(result.providerCalls || 0),
        duplicateInvocation: Boolean(result.duplicateInvocation),
        run: result.run || null,
      });
    }),
  );

  app.post(
    '/api/admin/submissions/:id/archive',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const result = await archiveLead({
        submissionId: request.params.id,
        reason: request.body?.reason || '',
        note: request.body?.note || '',
        communicationId: request.body?.communicationId || '',
        expectedUpdatedAt: request.body?.expectedUpdatedAt || request.body?.expected_updated_at || '',
        actor: session.username || 'admin',
        role: session.role || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.post(
    '/api/admin/submissions/:id/restore',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      const result = await restoreLead({
        submissionId: request.params.id,
        status: request.body?.status || 'review',
        expectedUpdatedAt: request.body?.expectedUpdatedAt || request.body?.expected_updated_at || '',
        actor: session.username || 'admin',
        role: session.role || 'admin',
      });
      response.status(result.status || (result.ok ? 200 : 400)).json({ success: Boolean(result.ok), ...result });
    }),
  );

  app.patch(
    '/api/admin/submissions/:id',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const updated = await updateSubmissionWorkflow(request.params.id, request.body || {}, {
        actor: session.username || 'admin',
        role: session.role || 'admin',
      });

      if (!updated) {
        response.status(400).json({ success: false, error: 'Invalid submission update payload.' });
        return;
      }

      if (updated.conflict) {
        response.status(409).json({
          success: false,
          error: 'This CRM record changed after you opened it. Reload the latest version before saving again.',
          submission: updated.current,
        });
        return;
      }

      response.json({
        success: true,
        submission: updated,
      });
    }),
  );

  app.delete(
    '/api/admin/submissions/:id',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const deleteResult = await deleteDashboardSubmission(request.params.id);

      if (!deleteResult) {
        response.status(404).json({ success: false, error: 'CRM record not found.' });
        return;
      }

      if (deleteResult.ok === false) {
        response.status(deleteResult.status || 500).json({
          success: false,
          error: deleteResult.error || 'Unable to delete CRM record.',
        });
        return;
      }

      response.json({
        success: true,
        submission: deleteResult.submission || deleteResult,
        cleanupPending: Boolean(deleteResult.cleanupPending),
        cleanupFailures: deleteResult.cleanupFailures || [],
      });
    }),
  );

  app.post(
    '/api/admin/submissions/:id/upload-request',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await createSecureUploadRequest({
        submissionId: request.params.id,
        requestedBy: session.username,
        note: String(request.body?.note || ''),
        requestedDocuments: Array.isArray(request.body?.requestedDocuments) ? request.body.requestedDocuments : [],
        sendEmail: request.body?.sendEmail !== false,
        request,
      });

      if (!result.ok) {
        response.status(400).json({ success: false, error: result.error });
        return;
      }

      response.json({
        success: true,
        uploadUrl: result.uploadUrl,
        request: result.request,
        emailResult: result.emailResult,
      });
    }),
  );

  app.get(
    '/api/admin/secure-documents/:id/download',
    asyncRoute(async (request, response) => {
      if (!await requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await getSecureDocumentDownload(request.params.id);

      if (!result.ok) {
        response.status(result.status || 404).json({ success: false, error: result.error || 'Secure document was not found.' });
        return;
      }

      const downloadName = result.document.original_name || result.document.file_name || 'secure-document';
      response.setHeader('Cache-Control', 'no-store, private');
      response.setHeader('Content-Type', result.document.mime_type || 'application/octet-stream');
      response.setHeader('Content-Length', String(result.sizeBytes || 0));
      response.download(result.filePath, downloadName, (error) => {
        if (error && !response.headersSent) {
          response.status(500).json({ success: false, error: 'Secure document download failed.' });
        }
      });
    }),
  );

  app.delete(
    '/api/admin/secure-documents/:id',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }
      const result = await deleteSecureDocument({ documentId: request.params.id, deletedBy: session.username });
      response.status(result.ok ? 200 : result.status || 400).json({ success: result.ok, ...result });
    }),
  );

  app.post(
    '/api/admin/secure-upload-requests/:id/revoke',
    asyncRoute(async (request, response) => {
      const session = await requireAdmin(request);
      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }
      const result = await revokeSecureUploadRequest({ requestId: request.params.id, revokedBy: session.username });
      response.status(result.ok ? 200 : result.status || 400).json({ success: result.ok, ...result });
    }),
  );

  app.get(
    '/api/secure-documents/request',
    asyncRoute(async (request, response) => {
      const result = await getSecureUploadContext(String(request.query.token || ''));

      if (!result.ok) {
        response.status(400).json({ success: false, error: result.error });
        return;
      }

      response.json({
        success: true,
        request: publicSecureUploadRequest(result.request),
        submission: {
          id: result.submission.id,
          name: result.submission.name,
          company: result.submission.company,
        },
        documents: result.documents.map(publicSecureDocument),
      });
    }),
  );

  app.post(
    '/api/secure-documents/upload',
    asyncRoute(async (request, response) => {
      const body = request.body || {};
      const result = await uploadSecureDocuments({
        token: request.secureUploadToken || body.token,
        ndaAccepted: Boolean(body.ndaAccepted),
        note: String(body.note || ''),
        documents: Array.isArray(body.documents) ? body.documents : [],
        completeRequest: Boolean(body.completeRequest),
        request,
      });

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }

      response.json({
        success: true,
        request: publicSecureUploadRequest(result.request),
        submission: {
          id: result.submission.id,
          name: result.submission.name,
          company: result.submission.company,
        },
        documents: result.documents.map(publicSecureDocument),
      });
    }),
  );

  app.use('/api', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(404).json({ success: false, error: 'API endpoint not found.' });
  });

  if (config.isProduction) {
    app.use(express.static(distDirectory, { redirect: false, setHeaders: setStaticAssetHeaders }));

    app.get('*', (request, response) => {
      const routePath = request.path.replace(/^\/+|\/+$/g, '');
      const routeIndex = routePath
        ? path.resolve(distDirectory, routePath, 'index.html')
        : path.join(distDirectory, 'index.html');
      const staysInsideDist = routeIndex === distDirectory || routeIndex.startsWith(`${distDirectory}${path.sep}`);

      response.setHeader('Cache-Control', entryDocumentCacheControl);
      response.sendFile(staysInsideDist && existsSync(routeIndex) ? routeIndex : path.join(distDirectory, 'index.html'));
    });
  }

  app.use(handleAppError);

  return app;
}
