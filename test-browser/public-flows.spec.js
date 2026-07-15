import { expect, test } from '@playwright/test';

test('public navigation, privacy, and focus access work without JavaScript errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /skip to content/i })).toBeFocused();
  await page.getByRole('link', { name: /privacy/i }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: /privacy/i })).toBeVisible();
  expect(errors).toEqual([]);
});

test('secure document and admin entry points fail safely without credentials', async ({ page }) => {
  await page.goto('/secure-documents');
  await expect(page.getByRole('alert')).toContainText(/missing a token/i);
  await page.route('**/api/admin/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({
        success: true,
        authenticated: false,
        authMode: 'hybrid',
        magicLinkEnabled: true,
        passwordEnabled: true,
      }),
    });
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: /authorized crm access/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
});
