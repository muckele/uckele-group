import { expect, test } from '@playwright/test';

const emptySummary = {
  total: 15,
  new: 0,
  review: 15,
  contacted: 0,
  archived: 0,
  spam: 0,
  lastSevenDays: 0,
  actionItems: 0,
  overdue: 0,
  dueSoon: 0,
  emailEngaged: 0,
  hotLeads: 0,
};

async function mockAuthenticatedAdmin(page) {
  await page.route('**/api/admin/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        authenticated: true,
        username: 'phase16-admin',
        role: 'admin',
        authMode: 'hybrid',
        magicLinkEnabled: true,
        passwordEnabled: true,
      }),
    });
  });

  await page.route('**/api/admin/submissions?*', async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get('page') || 1);
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        summary: emptySummary,
        submissions: [],
        notifications: [],
        emailTriage: [],
        total: 15,
        page: pageNumber,
        pageSize: Number(url.searchParams.get('pageSize') || 25),
        totalPages: 2,
        sort: url.searchParams.get('sort') || 'created_at',
        direction: url.searchParams.get('direction') || 'desc',
      }),
    });
  });

  await page.route('**/api/admin/operations', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        operations: {
          scheduler: { runs: [], failures: 0, pending: 0 },
          sources: { current: { healthy: true, generatedAt: '2026-07-13T18:00:00.000Z', issues: [] }, history: [] },
          audit: { events: [] },
          cleanup: { jobs: [], failures: [] },
          storage: {
            disk: { ok: true, totalBytes: 1000, freeBytes: 700, usedBytes: 300, freePercent: 70 },
            database: { ok: true, provider: 'sqlite', integrity: 'ok', fileBytes: 300 },
          },
          backup: { status: 'healthy', message: 'Latest backup verified.', latest: { createdAt: '2026-07-13T10:00:00.000Z', documentCount: 2 } },
        },
      }),
    });
  });

  await page.route('**/api/admin/follow-ups', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        summary: emptySummary,
        notifications: [],
        emailTriage: [],
        total: 15,
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
}

test('overview summary cards are keyboard-accessible drill-down links', async ({ page }) => {
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin');

  await expect(page.getByRole('link', { name: 'View Total Records: 15' })).toHaveAttribute('href', '/admin/crm');
  await expect(page.getByRole('link', { name: 'View Action Items: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=action-items');
  await expect(page.getByRole('link', { name: 'View Overdue: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=overdue');
  await expect(page.getByRole('link', { name: 'View Due Soon: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=due-soon');
  await expect(page.getByRole('link', { name: 'View Warm Leads: 0' })).toHaveAttribute('href', '/admin/follow-ups?view=warm-leads');
  await expect(page.getByRole('link', { name: 'View Last 7 Days: 0' })).toHaveAttribute('href', '/admin/crm?created=last-7-days');
  await expect(page.getByRole('link', { name: 'View Spam: 0' })).toHaveAttribute('href', '/admin/crm?status=spam');

  await page.getByRole('link', { name: 'View Last 7 Days: 0' }).click();
  await expect(page).toHaveURL(/\/admin\/crm\?created=last-7-days$/);
  await expect(page.getByLabel('Created').first()).toHaveValue('last-7-days');
});

test('authenticated CRM navigation persists page, size, sort, search, and status in the URL', async ({ page }) => {
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin/crm?search=HVAC&status=review&page=2&pageSize=10&sort=priority&direction=asc');

  await expect(page.getByRole('heading', { level: 1, name: 'CRM records' })).toBeVisible();
  await expect(page.getByLabel('Search CRM').first()).toHaveValue('HVAC');
  await expect(page.getByLabel('Status').first()).toHaveValue('review');
  await expect(page.getByLabel('Sort').first()).toHaveValue('priority:asc');
  await expect(page.getByLabel('Per page').first()).toHaveValue('10');
  await expect(page.getByText('11–15 of 15 records · Page 2 of 2').first()).toBeVisible();

  await page.getByRole('button', { name: /previous/i }).first().click();
  await expect(page.getByText('1–10 of 15 records · Page 1 of 2').first()).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
  expect(new URL(page.url()).searchParams.get('search')).toBe('HVAC');
  expect(new URL(page.url()).searchParams.get('pageSize')).toBe('10');

  await page.getByLabel('Sort').first().selectOption('deal_score:desc');
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('deal_score');
  await expect(page.getByLabel('Sort').first()).toHaveValue('deal_score:desc');

  await page.getByLabel('Sort').first().selectOption('listing_date:asc');
  await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('listing_date');
  await expect.poll(() => new URL(page.url()).searchParams.get('direction')).toBe('asc');
  await expect(page.getByLabel('Sort').first()).toHaveValue('listing_date:asc');
});

test('an authenticated administrator can reach the Operations Center', async ({ page }) => {
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin/operations');

  await expect(page.getByRole('heading', { name: /system health, history, and recovery readiness/i })).toBeVisible();
  await expect(page.getByText('70% free')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Job history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Audit events' })).toBeVisible();
});
