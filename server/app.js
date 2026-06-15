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
  getSecureDocumentDownload,
  getSecureUploadContext,
  uploadSecureDocuments,
} from './services/documentVault.js';
import { recordEmailEventsFromWebhook } from './services/emailEvents.js';
import {
  approveOutreachCadence,
  previewOutreachUnsubscribe,
  recordWebsiteVisit,
  runProspectAutomation,
  sendDueOutreachMessages,
  unsubscribeOutreachRecipient,
} from './services/prospectAutomation.js';
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

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function unsubscribePage({ ok, token = '', error = '', confirmed = false }) {
  const heading = confirmed ? 'You are unsubscribed.' : ok ? 'Confirm unsubscribe' : 'We could not process that link.';
  const message = confirmed
    ? 'You will no longer receive website audit outreach emails at this address.'
    : ok
      ? 'Use the button below to stop website audit outreach emails from Uckele Group.'
      : error || 'The unsubscribe link is invalid or expired.';
  const form = ok && !confirmed
    ? `
      <form method="post" action="/unsubscribe/${encodeURIComponent(token)}" style="margin-top:24px;">
        <button type="submit" style="border:1px solid #284638;border-radius:999px;background:#284638;color:#fff;font-size:15px;font-weight:700;padding:13px 18px;">Unsubscribe</button>
      </form>
    `
    : '';

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(heading)} | Uckele Group</title>
      </head>
      <body style="margin:0;background:#f8f4ed;color:#18211d;font-family:Arial,Helvetica,sans-serif;">
        <main style="max-width:620px;margin:12vh auto;padding:32px;">
          <p style="margin:0 0 10px;color:#7a5a3b;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">Uckele Group</p>
          <h1 style="margin:0 0 16px;font-size:32px;line-height:1.2;">${escapeHtml(heading)}</h1>
          <p style="margin:0;color:#33443b;font-size:16px;line-height:1.7;">${escapeHtml(message)}</p>
          ${form}
        </main>
      </body>
    </html>
  `;
}

export function createApp() {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');
  app.use(
    express.json({
      limit: '25mb',
      verify: (request, _response, buffer) => {
        request.rawBody = buffer.toString('utf8');
      },
    }),
  );
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

  app.post(
    '/api/track/visit',
    asyncRoute(async (request, response) => {
      const result = await recordWebsiteVisit(request.body || {}, request);
      response.status(result.ok ? 201 : 400).json(result);
    }),
  );

  app.get(
    '/unsubscribe/:token',
    asyncRoute(async (request, response) => {
      const result = previewOutreachUnsubscribe(request.params.token);
      response
        .status(result.ok ? 200 : result.status || 400)
        .type('html')
        .send(unsubscribePage({ ok: result.ok, token: request.params.token, error: result.error }));
    }),
  );

  app.post(
    '/unsubscribe/:token',
    asyncRoute(async (request, response) => {
      const result = await unsubscribeOutreachRecipient(request.params.token, request);
      const status = result.ok ? 200 : result.status || 400;

      if (request.accepts('html') && !request.accepts('json')) {
        response.status(status).type('html').send(unsubscribePage({ ok: result.ok, confirmed: result.ok, error: result.error }));
        return;
      }

      response.status(status).json(result);
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

  app.post(
    '/api/admin/submissions/:id/automation/run',
    asyncRoute(async (request, response) => {
      const session = requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await runProspectAutomation({
        submissionId: request.params.id,
        requestedBy: session.username,
      });

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }

      response.status(201).json({ success: true, ...result });
    }),
  );

  app.post(
    '/api/admin/submissions/:id/outreach/approve',
    asyncRoute(async (request, response) => {
      const session = requireAdmin(request);

      if (!session) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await approveOutreachCadence({
        submissionId: request.params.id,
        approvedBy: session.username,
      });

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error, reasons: result.reasons || [] });
        return;
      }

      response.json({ success: true, ...result });
    }),
  );

  app.post(
    '/api/admin/outreach/send-due',
    asyncRoute(async (request, response) => {
      if (!requireAdmin(request)) {
        response.status(401).json({ success: false, error: 'Unauthorized.' });
        return;
      }

      const result = await sendDueOutreachMessages({
        limit: Number(request.body?.limit) || undefined,
      });

      if (!result.ok) {
        response.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }

      response.json({ success: true, ...result });
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
        response.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }

      response.setHeader('Content-Type', result.document.mime_type || 'application/octet-stream');
      response.download(result.filePath, result.document.original_name || result.document.file_name);
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
      });

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
