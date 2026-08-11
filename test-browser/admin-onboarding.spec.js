import { expect, test } from '@playwright/test';

const summary = {
  total: 4,
  new: 1,
  review: 2,
  contacted: 1,
  archived: 0,
  spam: 0,
  lastSevenDays: 1,
  actionItems: 2,
  overdue: 1,
  dueSoon: 1,
  emailEngaged: 0,
  hotLeads: 0,
};

function normalizedProgress(body, previous = null, tourKey = 'admin-foundations') {
  const now = '2026-08-10T18:00:00.000Z';
  const nextStatus = previous?.status === 'completed'
    ? 'completed'
    : previous?.status === 'skipped' && body.status !== 'completed'
      ? 'skipped'
      : body.status;

  return {
    tourKey,
    tourVersion: 1,
    status: nextStatus,
    lastCompletedStepId: nextStatus === previous?.status && nextStatus !== body.status
      ? previous.lastCompletedStepId
      : body.lastCompletedStepId || previous?.lastCompletedStepId || null,
    startedAt: previous?.startedAt || now,
    updatedAt: nextStatus === previous?.status && nextStatus !== body.status ? previous.updatedAt : now,
    completedAt: nextStatus === 'completed' ? (previous?.completedAt || now) : null,
    skippedAt: nextStatus === 'skipped' ? (previous?.skippedAt || now) : null,
  };
}

async function mockAdminApplication(page, { role = 'admin', initialProgress = null } = {}) {
  const state = {
    progress: initialProgress,
    otherProgress: {},
    patches: [],
    onboardingGets: 0,
  };

  await page.route('**/api/admin/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ success: true }),
    });
  });

  await page.route('**/api/admin/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        authenticated: true,
        username: role === 'viewer' ? 'onboarding-viewer' : 'onboarding-admin',
        role,
        authMode: 'hybrid',
        magicLinkEnabled: true,
        passwordEnabled: true,
      }),
    });
  });

  await page.route('**/api/admin/submissions?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        summary,
        submissions: [],
        notifications: [],
        emailTriage: [],
        total: summary.total,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        sort: 'created_at',
        direction: 'desc',
      }),
    });
  });

  await page.route('**/api/admin/submissions/*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 404,
      body: JSON.stringify({ success: false, error: 'The mocked CRM record was not found.' }),
    });
  });

  await page.route('**/api/admin/submissions/*/activity', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ success: true, events: [] }),
    });
  });

  await page.route('**/api/admin/follow-ups?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        items: [],
        summary,
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });

  await page.route('**/api/admin/acquisition-command-center', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ success: true, commandCenter: null }),
    });
  });

  await page.route('**/api/admin/onboarding', async (route) => {
    state.onboardingGets += 1;
    const progress = [state.progress, ...Object.values(state.otherProgress)].filter(Boolean);
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ success: true, progress }),
    });
  });

  await page.route('**/api/admin/onboarding/*', async (route) => {
    const body = route.request().postDataJSON();
    const tourKey = new URL(route.request().url()).pathname.split('/').at(-1);
    state.patches.push(body);
    const previous = tourKey === 'admin-foundations' ? state.progress : state.otherProgress[tourKey] || null;
    const saved = normalizedProgress(body, previous, tourKey);
    if (tourKey === 'admin-foundations') state.progress = saved;
    else state.otherProgress[tourKey] = saved;
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ success: true, progress: saved }),
    });
  });

  return state;
}

test('a new admin completes foundations once, can replay it, and leaves no keyboard trap', async ({ page }) => {
  const state = await mockAdminApplication(page);
  await page.goto('/admin');

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Welcome to the acquisition workspace');

  await dialog.getByRole('button', { name: /^Next/ }).click();
  await expect(dialog.getByRole('button', { name: 'Back' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog).toContainText('Welcome to the acquisition workspace');

  for (let step = 0; step < 4; step += 1) {
    await dialog.getByRole('button', { name: /^Next/ }).click();
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => state.progress?.status).toBe('completed');
  expect(state.patches.map((patch) => patch.status)).toContain('in_progress');
  expect(state.patches.at(-1).status).toBe('completed');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Guide this page' })).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(state.onboardingGets).toBe(2);

  const guide = page.getByRole('button', { name: 'Guide this page' });
  await guide.click();
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 7; index += 1) {
    await page.keyboard.press('Tab');
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(guide).toBeFocused();
  await expect(page.locator('#react-joyride-portal')).toHaveCount(0);
  expect(state.progress.status).toBe('completed');
  expect(state.patches.at(-1).status).toBe('completed');
});

test('the foundations dialog reflows at 320px and respects reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockAdminApplication(page);
  await page.goto('/admin');

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('a route guide with missing asynchronous targets releases its dialog and overlay', async ({ page }) => {
  const completed = normalizedProgress({ status: 'completed', lastCompletedStepId: 'foundations-page-guide' });
  await mockAdminApplication(page, { initialProgress: completed });
  await page.goto('/admin/crm/missing-record');

  await expect(page.getByRole('heading', { level: 1, name: 'CRM record detail' })).toBeVisible();
  await page.getByRole('button', { name: 'Guide this page' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This is the record workspace');
  await dialog.getByRole('button', { name: /^Next/ }).click();
  await expect(dialog).toBeHidden({ timeout: 8_000 });
  await expect(page.locator('#react-joyride-portal')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Guide this page' })).toBeEnabled();
  await expect(page.getByRole('heading', { level: 1, name: 'CRM record detail' })).toBeVisible();
});

test('viewer guidance excludes admin-only routes and public routes never load onboarding', async ({ page }) => {
  const completed = normalizedProgress({ status: 'completed', lastCompletedStepId: 'foundations-page-guide' });
  await mockAdminApplication(page, { role: 'viewer', initialProgress: completed });
  await page.goto('/admin');

  await expect(page.getByRole('link', { name: 'Operations' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New Record' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Guide this page' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText(/send|approve|import|edit/i);
  await dialog.getByRole('button', { name: 'Close' }).click();

  const publicPage = await page.context().newPage();
  const onboardingRequests = [];
  publicPage.on('request', (request) => {
    if (request.url().includes('/api/admin/onboarding')) onboardingRequests.push(request.url());
  });
  await publicPage.goto('/');
  await expect(publicPage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(publicPage.getByRole('button', { name: 'Guide this page' })).toHaveCount(0);
  await expect(publicPage.locator('[data-admin-tour]')).toHaveCount(0);
  await publicPage.goto('/secure-documents');
  await expect(publicPage.getByRole('alert')).toContainText(/missing a token/i);
  await expect(publicPage.getByRole('button', { name: 'Guide this page' })).toHaveCount(0);
  await expect(publicPage.locator('[data-admin-tour]')).toHaveCount(0);
  expect(onboardingRequests).toEqual([]);
  await publicPage.close();
});
