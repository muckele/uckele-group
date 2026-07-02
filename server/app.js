import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
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
  verifyAdminMagicLink,
} from './services/auth.js';
import {
  createSecureUploadRequest,
  enforceSecureUploadBodyRateLimit,
  getSecureUploadJsonLimitBytes,
  getSecureUploadContext,
  getSecureDocumentDownload,
  uploadSecureDocuments,
} from './services/documentVault.js';
import { recordEmailEventsFromWebhook } from './services/emailEvents.js';
import {
  reviewDailyDeals,
  runDealHunterCimFollowUps,
  sendDailyDealHunterReview,
  sendDealHunterCimRequest,
  sendDealHunterReadyCimRequests,
} from './services/dealHunter.js';
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

export function handleAppError(error, _request, response, next) {
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
    console.error(error);
  } else {
    console.warn(error?.message || error);
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
  };
}

export function createApp() {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');
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
  app.use(express.json(jsonParserOptions('25mb')));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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

  app.get('/api/public-config', (_request, response) => {
    response.json({
      success: true,
      turnstileSiteKey: config.turnstile.siteKey,
      turnstileEnabled: Boolean(config.turnstile.siteKey && config.turnstile.secretKey),
    });
  });

  app.post(
    '/api/contact',
    asyncRoute(async (request, response) => {
      const result = await submitContactLead(request.body, request);
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

  app.get('/api/admin/session', (request, response) => {
    const session = getAdminSession(request);

    response.json({
      authenticated: Boolean(session),
      username: session?.username || '',
      role: session?.role || '',
      ...getAdminAuthState(),
    });
  });

  app.post(
    '/api/admin/session',
    asyncRoute(async (request, response) => {
      const result = await loginAdmin(request.body.username || '', request.body.password || '', request);

      if (!result.ok) {
        response.status(result.status || 401).json({ success: false, error: result.reason });
        return;
      }

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
      const result = await requestAdminMagicLink(request.body.email || '', request);

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

  app.post('/api/admin/magic-link/verify', (request, response) => {
    const result = verifyAdminMagicLink(request.body.token || '');

    if (!result.ok) {
      response.status(401).json({ success: false, error: result.reason });
      return;
    }

    response.setHeader('Set-Cookie', result.cookie);
    response.json({
      success: true,
      username: result.session.username,
      role: result.session.role,
    });
  });

  app.delete('/api/admin/session', (_request, response) => {
    response.setHeader('Set-Cookie', logoutAdmin());
    response.json({ success: true });
  });

  app.get(
    '/api/admin/acquisition-command-center',
    asyncRoute(async (request, response) => {
      const session = requireAdminAccess(request);

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

  app.post(
    '/api/admin/acquisition-command-center/:id',
    asyncRoute(async (request, response) => {
      const session = requireAdmin(request);

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
      if (!requireAdminAccess(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await listDashboardSubmissions({
        page: Number(request.query.page) || 1,
        search: String(request.query.search || ''),
        status: String(request.query.status || 'all'),
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
      if (!requireAdminAccess(request)) {
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
      const session = requireAdmin(request);

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
      if (!requireAdmin(request)) {
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
      if (!requireAdminAccess(request)) {
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
    '/api/admin/deal-hunter/review',
    asyncRoute(async (request, response) => {
      const session = requireAdminAccess(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const review = await reviewDailyDeals();
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
      if (!requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await sendDailyDealHunterReview();
      response.status(result.emailResult.status === 'failed' ? 502 : 200).json({
        success: result.emailResult.status !== 'failed',
        ...result,
      });
    }),
  );

  app.post(
    '/api/admin/deal-hunter/cim-request',
    asyncRoute(async (request, response) => {
      const session = requireAdmin(request);

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
      const session = requireAdmin(request);

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
    '/api/admin/deal-hunter/cim-follow-ups/run',
    asyncRoute(async (request, response) => {
      if (!requireAdmin(request)) {
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

      const result = await sendDailyDealHunterReview();
      response.status(result.emailResult.status === 'failed' ? 502 : 200).json({
        success: result.emailResult.status !== 'failed',
        ...result,
      });
    }),
  );

  app.patch(
    '/api/admin/submissions/:id',
    asyncRoute(async (request, response) => {
      if (!requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const updated = await updateSubmissionWorkflow(request.params.id, request.body || {});

      if (!updated) {
        response.status(400).json({ success: false, error: 'Invalid submission update payload.' });
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
      if (!requireAdmin(request)) {
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
      });
    }),
  );

  app.post(
    '/api/admin/submissions/:id/upload-request',
    asyncRoute(async (request, response) => {
      const session = requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await createSecureUploadRequest({
        submissionId: request.params.id,
        requestedBy: session.username,
        note: String(request.body.note || ''),
        sendEmail: request.body.sendEmail !== false,
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
      if (!requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await getSecureDocumentDownload(request.params.id);

      if (!result.ok) {
        response.status(result.status || 404).json({ success: false, error: result.error || 'Secure document was not found.' });
        return;
      }

      const downloadName = result.document.original_name || result.document.file_name || 'secure-document';
      response.setHeader('Content-Type', result.document.mime_type || 'application/octet-stream');
      response.setHeader('Content-Length', String(result.sizeBytes || 0));
      response.download(result.filePath, downloadName, (error) => {
        if (error && !response.headersSent) {
          response.status(500).json({ success: false, error: 'Secure document download failed.' });
        }
      });
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
      const result = await uploadSecureDocuments({
        token: request.body.token,
        ndaAccepted: Boolean(request.body.ndaAccepted),
        note: String(request.body.note || ''),
        documents: Array.isArray(request.body.documents) ? request.body.documents : [],
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

  if (config.isProduction) {
    app.use(express.static(distDirectory));

    app.get('*', (_request, response) => {
      response.sendFile(path.join(distDirectory, 'index.html'));
    });
  }

  app.use(handleAppError);

  return app;
}

export const app = createApp();
