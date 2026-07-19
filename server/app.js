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
  reviewDailyDeals,
  runDealHunterCimFollowUps,
  sendDealHunterCimRequest,
  sendDealHunterReadyCimRequests,
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
import { listCrmActivity } from './services/activity.js';
import { getOperationsCenter } from './services/operations.js';
import { recordAnalyticsEvent } from './services/analytics.js';
import {
  getCimAutomationStatus,
  recordCimResponseOutcome,
  recordCimReviewDecisions,
  setCimAutomationPaused,
} from './services/cimAutomation.js';

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
    console.error(`[request:${request.id || 'unknown'}]`, error);
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

export function createApp() {
  const config = getConfig();
  const app = express();
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
      if (!await requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Administrator access is required.' });
        return;
      }

      response.json({ success: true, operations: await getOperationsCenter() });
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

      const result = await listDashboardFollowUps();

      response.json({
        success: true,
        ...result,
      });
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

      response.json({ success: true, events });
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
      await setCimAutomationPaused({ paused: request.body.paused, actor: session.username || 'admin' });
      response.json({ success: true, automation: await getCimAutomationStatus() });
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
    app.use(express.static(distDirectory, { redirect: false }));

    app.get('*', (request, response) => {
      const routePath = request.path.replace(/^\/+|\/+$/g, '');
      const routeIndex = routePath
        ? path.resolve(distDirectory, routePath, 'index.html')
        : path.join(distDirectory, 'index.html');
      const staysInsideDist = routeIndex === distDirectory || routeIndex.startsWith(`${distDirectory}${path.sep}`);

      response.sendFile(staysInsideDist && existsSync(routeIndex) ? routeIndex : path.join(distDirectory, 'index.html'));
    });
  }

  app.use(handleAppError);

  return app;
}
