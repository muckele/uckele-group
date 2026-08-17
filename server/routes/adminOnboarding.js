import { requireAdminAccess } from '../services/auth.js';
import {
  AdminOnboardingRequestError,
  listAdminOnboardingProgressForSession,
  updateAdminOnboardingProgressForSession,
} from '../services/adminOnboarding.js';
import { asyncRoute } from '../utils/http.js';

export function registerAdminOnboardingRoutes(app, {
  requireAccess = requireAdminAccess,
  listProgress = listAdminOnboardingProgressForSession,
  updateProgress = updateAdminOnboardingProgressForSession,
} = {}) {
  app.get('/api/admin/onboarding', asyncRoute(async (request, response) => {
    const session = await requireAccess(request);
    if (!session) {
      response.status(401).json({ success: false, error: 'Unauthorized.', code: 'unauthenticated' });
      return;
    }

    response.json({
      success: true,
      progress: await listProgress(session),
    });
  }));

  app.patch('/api/admin/onboarding/:tourKey', asyncRoute(async (request, response) => {
    const session = await requireAccess(request);
    if (!session) {
      response.status(401).json({ success: false, error: 'Unauthorized.', code: 'unauthenticated' });
      return;
    }

    try {
      const progress = await updateProgress(session, request.params.tourKey, request.body);
      response.json({ success: true, progress });
    } catch (error) {
      if (error instanceof AdminOnboardingRequestError) {
        response.status(error.status).json({ success: false, error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  }));
}
