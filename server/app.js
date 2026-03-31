import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import {
  getAdminAuthState,
  getAdminSession,
  loginAdmin,
  logoutAdmin,
  requestAdminMagicLink,
  requireAdmin,
  verifyAdminMagicLink,
} from './services/auth.js';
import {
  createSecureUploadRequest,
  getSecureUploadContext,
  uploadSecureDocuments,
} from './services/documentVault.js';
import {
  createManualSubmission,
  exportDashboardSubmissionsCsv,
  listDashboardSubmissions,
  submitContactLead,
  updateSubmissionWorkflow,
} from './services/submissions.js';
import { asyncRoute } from './utils/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.resolve(__dirname, '../dist');

export function createApp() {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  app.use((request, response, next) => {
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      storageProvider: config.storage.provider,
      deliveryProvider: config.delivery.provider,
      turnstileEnabled: Boolean(config.turnstile.secretKey),
      adminAuthMode: config.admin.authMode,
    });
  });

  app.post(
    '/api/contact',
    asyncRoute(async (request, response) => {
      const result = await submitContactLead(request.body, request);
      response.status(result.status).json(result.body);
    }),
  );

  app.get('/api/admin/session', (request, response) => {
    const session = getAdminSession(request);

    response.json({
      authenticated: Boolean(session),
      username: session?.username || '',
      ...getAdminAuthState(),
    });
  });

  app.post('/api/admin/session', (request, response) => {
    const result = loginAdmin(request.body.username || '', request.body.password || '');

    if (!result.ok) {
      response.status(401).json({ success: false, error: result.reason });
      return;
    }

    response.setHeader('Set-Cookie', result.cookie);
    response.json({
      success: true,
      username: result.session.username,
    });
  });

  app.post(
    '/api/admin/magic-link/request',
    asyncRoute(async (request, response) => {
      const result = await requestAdminMagicLink(request.body.email || '', request);

      if (!result.ok) {
        response.status(400).json({ success: false, error: result.reason });
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
    });
  });

  app.delete('/api/admin/session', (_request, response) => {
    response.setHeader('Set-Cookie', logoutAdmin());
    response.json({ success: true });
  });

  app.get(
    '/api/admin/submissions',
    asyncRoute(async (request, response) => {
      if (!requireAdmin(request)) {
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
    '/api/secure-documents/request',
    asyncRoute(async (request, response) => {
      const result = await getSecureUploadContext(String(request.query.token || ''));

      if (!result.ok) {
        response.status(400).json({ success: false, error: result.error });
        return;
      }

      response.json({
        success: true,
        request: result.request,
        submission: {
          id: result.submission.id,
          name: result.submission.name,
          company: result.submission.company,
        },
        documents: result.documents,
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
      });

      if (!result.ok) {
        response.status(400).json({ success: false, error: result.error });
        return;
      }

      response.json({
        success: true,
        request: result.request,
        submission: {
          id: result.submission.id,
          name: result.submission.name,
          company: result.submission.company,
        },
        documents: result.documents,
      });
    }),
  );

  if (config.isProduction) {
    app.use(express.static(distDirectory));

    app.get('*', (_request, response) => {
      response.sendFile(path.join(distDirectory, 'index.html'));
    });
  }

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({
      success: false,
      error: 'Something went wrong while processing the request.',
    });
  });

  return app;
}

export const app = createApp();
