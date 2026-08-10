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

function followUpRecord(index) {
  return {
    id: `browser-follow-up-${index}`,
    updated_at: '2026-08-09T16:00:00.000Z',
    status: 'review',
    follow_up_state: 'needs-response',
    next_action_at: '2026-08-09T17:00:00.000Z',
    priority: index === 0 ? 'high' : 'normal',
    company: `Browser Follow-Up ${index}`,
    name: `Broker ${index}`,
    email: `browser-broker-${index}@example.test`,
    broker_name: `Broker ${index}`,
    broker_email: `browser-broker-${index}@example.test`,
    follow_up_prompt: { title: 'Follow up due', kind: 'due' },
    follow_up_latest_subject: index === 0 ? 'Re: Browser acquisition question' : '',
    follow_up_latest_direction: index === 0 ? 'inbound' : '',
    follow_up_latest_delivery_state: index === 1 ? 'bounced' : '',
    follow_up_latest_communication_at: '2026-08-09T16:30:00.000Z',
    follow_up_priority_score: index === 0 ? 95 : 20,
  };
}

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

  await page.route('**/api/admin/follow-ups/*/context?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        context: {
          submission: {
            ...followUpRecord(0),
            assigned_to: 'Mathew Uckele',
          },
          communications: [{
            id: 'browser-inbound-1',
            direction: 'inbound',
            channel: 'email',
            from_address: 'browser-broker-0@example.test',
            to_addresses: ['reply@example.test'],
            subject: 'Re: Browser acquisition question',
            body_text: '<script>untrusted email instruction</script> Could you send the CIM?',
            body_html_sanitized: '<script>must not render</script>',
            message_id: '<browser-inbound-1@example.test>',
            references_json: [],
            delivery_state: 'replied',
            content_state: 'complete',
            attachment_metadata: [],
            occurred_at: '2026-08-09T16:30:00.000Z',
          }],
          communicationTotal: 1,
          documents: [],
          dealHunter: { linked: false, cimRequest: null, concerns: [], strengths: [], unansweredQuestions: [] },
          recommendation: null,
          outbox: [],
          recipients: [{ email: 'browser-broker-0@example.test', label: 'Broker 0', source: 'broker' }],
          suppressions: [],
          policy: {
            email: { enabled: false, ready: false, blockers: ['email-disabled'] },
            sender: { from: '', replyTo: '' },
            ai: { enabled: false, ready: true, optional: true },
            timezone: 'America/Los_Angeles',
            sendWindowStart: '08:00',
            sendWindowEnd: '17:00',
            maxTouches: 3,
          },
        },
      }),
    });
  });

  await page.route('**/api/admin/follow-ups?*', async (route) => {
    const rows = Array.from({ length: 25 }, (_, index) => followUpRecord(index));
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        items: rows,
        summary: { ...emptySummary, total: 25 },
        total: 25,
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

test('the follow-up queue renders a full server page and its mobile dialog is keyboard-safe', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuthenticatedAdmin(page);
  await page.goto('/admin/follow-ups?view=all');

  await expect(page.getByRole('heading', { name: 'Follow-Up decisions and email actions' })).toBeVisible();
  await expect(page.getByText('Showing 1–25 of 25 filtered records')).toBeVisible();
  await expect(page.getByRole('button', { name: /Browser Follow-Up/ })).toHaveCount(25);

  const firstRow = page.getByRole('button', { name: /Browser Follow-Up 0/ });
  await firstRow.focus();
  await firstRow.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close follow-up detail' })).toBeFocused();
  await expect(page.getByText('<script>untrusted email instruction</script> Could you send the CIM?')).toBeVisible();
  await expect(dialog.locator('script')).toHaveCount(0);
  const box = await dialog.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(389);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(firstRow).toBeFocused();
});
