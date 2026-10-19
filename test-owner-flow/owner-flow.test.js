import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { createOwnerReviewRoutePolicy } from './review-route-policy.js';
import { startFixture, cases } from './fixture.js';
import { observeOwnedBrowserSpawn } from '../scripts/fl05-owned-process.js';

test('FL05 backend walkthrough: owner persistence, CRM restore boundary, mobile and viewer', { timeout: 120_000 }, async (t) => {
  let humanGuardEnabled = false;
  const humanGuard = createOwnerReviewRoutePolicy({ opportunityIds: cases.map((item) => item.id), crmIds: cases.filter((item) => item.linked).map((item) => `crm-${item.id}`) });
  const fixture = await startFixture(t, { requestPolicy: (method, url) => !humanGuardEnabled || humanGuard(method, url) });
  const browserPidPath = path.join(fixture.root, 'owned-browser.json');
  const restoreSpawn = observeOwnedBrowserSpawn(process.env.FL05_BROWSER_EXECUTABLE, (pid) => {
    const temporary = `${browserPidPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ pid }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, browserPidPath);
  });
  t.after(restoreSpawn);
  const browserServer = await chromium.launchServer({ executablePath: process.env.FL05_BROWSER_EXECUTABLE, host: '127.0.0.1',
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  t.after(() => browserServer.close());
  const browserPid = browserServer.process().pid;
  const registration = path.join(fixture.root, 'browser-registered');
  assert.equal(JSON.parse(fs.readFileSync(browserPidPath, 'utf8')).pid, browserPid);
  const registerDeadline = performance.now() + 5000;
  while (!fs.existsSync(registration) && performance.now() < registerDeadline) await delay(25);
  assert.equal(fs.readFileSync(registration, 'utf8'), String(browserPid), 'Runner must own browser cleanup before the journey');
  const browser = await chromium.connect(browserServer.wsEndpoint());
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const external = [], errors = [], timings = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
  page.setDefaultTimeout(10_000);
  const detail = async (id) => {
    const response = await context.request.get(`${fixture.origin}/api/admin/deal-hunter/triage/${id}`);
    assert.equal(response.status(), 200);
    return response.json();
  };
  const measure = async (name, action) => {
    const start = performance.now(); await action(); timings.push({ name, elapsedMs: Math.round(performance.now() - start) });
  };
  const closeDetail = async () => {
    await expect(page.getByRole('button', { name: 'Close opportunity detail' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  try {
    await page.goto(`${fixture.origin}/admin/deal-hunter`);
    await page.getByLabel('Username', { exact: true }).fill('fl05-owner');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-owner-password');
    await measure('password-login-to-inbox', async () => {
      await page.getByRole('button', { name: 'Sign In With Password' }).click();
      await expect(page.getByRole('heading', { name: 'Acquisition Inbox', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'New & Important', exact: true })
        .getByRole('button', { name: 'Open Synthetic Fresh High Fit', exact: true })).toBeVisible();
    });
    assert.match(await page.title(), /Uckele/);
    assert.equal(new URL(page.url()).pathname, '/admin/deal-hunter');
    const fresh = page.getByRole('region', { name: 'New & Important', exact: true });
    await expect(fresh.getByText('Recently listed', { exact: false })).toBeVisible();
    await expect(fresh.getByRole('button', { name: 'Open Synthetic Older High Fit', exact: true })).toHaveCount(0);
    await expect(fresh.getByRole('button', { name: 'Open Synthetic New Low Fit', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Needs Your Action', exact: true })).toContainText('Synthetic Broker Reply');
    await expect(page.getByRole('region', { name: 'Needs Your Action', exact: true })).toContainText('Synthetic Broker Materials');
    await page.screenshot({ path: path.join(fixture.root, 'desktop-inbox.png') });

    const open = page.getByRole('button', { name: 'Open Synthetic Fresh High Fit', exact: true });
    await open.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close opportunity detail' })).toBeFocused();
    await dialog.getByLabel('Verified fact field').selectOption('broker_company');
    await dialog.getByLabel('Verified fact value').fill('Synthetic fire safety service');
    await dialog.getByLabel('Verification note', { exact: true }).fill('FL05 synthetic correction');
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT'
      && response.url().endsWith('/facts/broker_company'));
    await dialog.getByRole('button', { name: 'Save verified fact' }).click();
    assert.equal((await saved).status(), 200);
    await expect(dialog).toContainText('FL05 synthetic correction');
    await page.reload();
    await page.getByRole('button', { name: 'Open Synthetic Fresh High Fit', exact: true }).click();
    await expect(dialog).toContainText('Synthetic fire safety service');
    const edited = await detail('fresh');
    assert.equal(edited.effectiveFacts.broker_company.value, 'Synthetic fire safety service');
    assert.equal(edited.effectiveFacts.broker_company.provenance, 'operator');
    const storedScore = fixture.db.prepare("SELECT * FROM deal_hunter_opportunity_scores WHERE opportunity_id='fresh'").get();
    const sourceRows = fixture.db.prepare("SELECT * FROM deal_hunter_opportunity_source_observations WHERE opportunity_id='fresh' ORDER BY id").all();
    for (const [field, amount, currency, metric, period] of [['annual_profit','-125.55','CAD','ebitda','annual'], ['annual_revenue','1800000.25','USD','revenue','trailing-twelve-months'], ['asking_price','0','unknown','asking-price','current']]) {
      await dialog.getByLabel('Verified fact field').selectOption(field);
      await dialog.getByLabel('Verified fact value').fill(amount);
      await dialog.getByLabel('Financial currency').selectOption(currency);
      await dialog.getByLabel('Financial metric').selectOption(metric);
      await dialog.getByLabel('Financial period').selectOption(period);
      await dialog.getByLabel('Financial evidence source').fill('Synthetic owner financial correction');
      const financialSaved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/facts/${field}`));
      await dialog.getByRole('button', { name: 'Save financial fact' }).click();
      assert.equal((await financialSaved).status(), 200);
      await expect(dialog.getByRole('button', { name: 'Save financial fact' })).toBeEnabled();
    }
    await page.reload();
    await page.getByRole('button', { name: 'Open Synthetic Fresh High Fit', exact: true }).click();
    const financialDetail = await detail('fresh');
    assert.equal(financialDetail.opportunity.financials.annualProfit, -125.55);
    assert.equal(financialDetail.opportunity.financials.annualRevenue, 1800000.25);
    assert.equal(financialDetail.opportunity.financials.askingPrice, 0);
    assert.equal(financialDetail.opportunity.financials.profitMultiple, null);
    assert.equal(financialDetail.missingCriticalFields.includes('asking_price'), false);
    assert.equal(financialDetail.effectiveFacts.annual_profit.verified, false);
    assert.deepEqual(fixture.db.prepare("SELECT * FROM deal_hunter_opportunity_scores WHERE opportunity_id='fresh'").get(), storedScore);
    assert.deepEqual(fixture.db.prepare("SELECT * FROM deal_hunter_opportunity_source_observations WHERE opportunity_id='fresh' ORDER BY id").all(), sourceRows);
    await expect(dialog).toContainText('-125.55 CAD');
    await expect(dialog).toContainText('saved machine score has not been recomputed');
    await dialog.getByRole('heading', { name: 'Business & Financials', exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByText('-125.55 CAD', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(fixture.root, 'financial-corrections.png') });
    await dialog.getByRole('button', { name: 'Pursue Synthetic Fresh High Fit', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Pursue next action' })).toContainText('Create or link the CRM record');
    await dialog.getByRole('button', { name: 'Pass Synthetic Fresh High Fit', exact: true }).click();
    await dialog.getByLabel('Pass reason', { exact: true }).fill('Synthetic owner Pass');
    await dialog.getByLabel('Pass note (optional)', { exact: true }).fill('Retained unlinked Pass note');
    await dialog.getByRole('button', { name: 'Confirm Pass', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('tab', { name: 'Passed', exact: true }).click();
    await page.getByRole('button', { name: 'Open Synthetic Fresh High Fit', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Restore opportunity', exact: true })).toBeEnabled();
    const passedUnlinked = await detail('fresh');
    fixture.db.prepare(`INSERT INTO email_suppressions(id,normalized_email,reason,source,created_at,created_by,metadata)
      VALUES ('11111111-4444-4444-8444-111111111111','broker-fresh@example.test','explicit-opt-out','synthetic-fixture',?,'fixture-owner','{"retained":true}')`).run(new Date().toISOString());
    const crmBeforeRestore = fixture.db.prepare('SELECT * FROM contact_submissions ORDER BY id').all();
    const protectedTables = ['email_suppressions','deal_hunter_pursuit_enrollments','deal_hunter_cim_campaigns','deal_hunter_cim_capability_activations','deal_hunter_cim_live_provider_authorizations','deal_hunter_cim_transmissions','crm_email_outbox'];
    const protectedBeforeRestore = Object.fromEntries(protectedTables.map((table) => [table, fixture.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    await dialog.getByRole('button', { name: 'Restore opportunity', exact: true }).click();
    const restoreResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/triage/fresh/restore'));
    await dialog.getByRole('button', { name: 'Confirm Restore opportunity', exact: true }).click();
    assert.equal((await restoreResponse).status(), 200);
    await expect(dialog.getByRole('button', { name: 'Pursue Synthetic Fresh High Fit', exact: true })).toBeEnabled();
    const restoredUnlinked = await detail('fresh');
    assert.equal(restoredUnlinked.opportunity.dismissed, false);
    assert.equal(restoredUnlinked.opportunity.factEditRevision.primarySubmissionId, null);
    assert.equal(restoredUnlinked.history.dispositions[0].note, 'Retained unlinked Pass note');
    assert.equal(restoredUnlinked.history.dispositions[0].restoredBy, 'fl05-owner');
    assert.deepEqual(fixture.db.prepare('SELECT * FROM contact_submissions ORDER BY id').all(), crmBeforeRestore);
    assert.deepEqual(Object.fromEntries(protectedTables.map((table) => [table, fixture.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])), protectedBeforeRestore);
    assert.equal((await context.request.post(`${fixture.origin}/api/admin/deal-hunter/triage/fresh/restore`, { data: passedUnlinked.restoreAuthority })).status(), 409);
    await page.screenshot({ path: path.join(fixture.root, 'unlinked-restored.png') });
    await closeDetail();

    await page.getByRole('tab', { name: 'Fresh-first Inbox', exact: true }).click();
    await page.getByRole('button', { name: 'Updated since review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Updated since review', exact: true })).toContainText('1500000 → 1250000 USD');
    await page.getByRole('button', { name: 'All active', exact: true }).click();
    const all = page.getByRole('region', { name: 'All active', exact: true });
    for (const name of ['Synthetic Older High Fit', 'Synthetic New Low Fit', 'Synthetic Unknown Age']) {
      await expect(all.getByRole('button', { name: `Open ${name}`, exact: true })).toBeVisible();
    }
    await expect(all.getByRole('button', { name: 'Open Synthetic Archived Reimport', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Synthetic Unknown Age', exact: true }).click();
    await expect(dialog).toContainText('Listing age unknown');
    await closeDetail();
    await page.getByRole('button', { name: 'Pass Synthetic New Low Fit', exact: true }).click();
    await page.getByLabel('Pass reason', { exact: true }).fill('outside-buy-box');
    await page.getByLabel('Pass note (optional)', { exact: true }).fill('FL05 exact retained decision note');
    await page.getByRole('button', { name: 'Confirm Pass', exact: true }).click();
    await expect(all.getByRole('button', { name: 'Open Synthetic New Low Fit', exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByRole('tab', { name: 'Passed', exact: true }).click();
    await measure('archive-search-to-result', async () => {
      await page.getByLabel('Search opportunities', { exact: true }).fill('FL05 exact retained decision note');
      await expect(page.getByRole('button', { name: 'Open Synthetic New Low Fit', exact: true })).toBeVisible();
    });
    await expect(page.getByText('Decision note: FL05 exact retained decision note')).toBeVisible();
    const passed = await detail('low');
    assert.equal(passed.opportunity.dismissed, true);
    assert.equal(passed.opportunity.dismissedReason, 'outside-buy-box');
    await page.getByRole('button', { name: 'Open Synthetic New Low Fit', exact: true }).click();
    await dialog.getByRole('link', { name: 'Open linked CRM record', exact: true }).click();
    await page.getByRole('button', { name: 'Restore Lead', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Restore', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Archive Lead', exact: true })).toBeVisible();
    const restored = fixture.db.prepare('SELECT status, follow_up_state, next_action_at FROM contact_submissions WHERE id = ?').get('crm-low');
    assert.deepEqual(restored, { status: 'review', follow_up_state: 'completed', next_action_at: null });
    assert.equal((await detail('low')).opportunity.dismissed, false,
      'CRM Restore must atomically clear the exact linked canonical Pass');

    humanGuardEnabled = true;
    await page.goto(`${fixture.origin}/admin/crm`);
    await expect(page.getByText('Records index', { exact: true })).toBeVisible();
    await expect(page.getByText('Synthetic New Low Fit', { exact: true }).first()).toBeVisible();
    assert.ok(fixture.requests.some((request) => request.path.startsWith('/api/admin/submissions?') && request.status === 200));
    await page.screenshot({ path: path.join(fixture.root, 'guarded-crm-index.png') });
    const deniedSend = await context.request.post(`${fixture.origin}/api/admin/deal-hunter/cim-requests`, { data: {} });
    assert.equal(deniedSend.status(), 403);
    humanGuardEnabled = false;

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${fixture.origin}/admin/deal-hunter`);
    await page.getByRole('button', { name: 'All active', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Synthetic New Low Fit', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Passed', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Synthetic New Low Fit', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Fresh-first Inbox', exact: true }).click();
    await page.getByRole('button', { name: 'All active', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Synthetic Unknown Age', exact: true })).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile must not overflow horizontally');
    await page.screenshot({ path: path.join(fixture.root, 'mobile-inbox.png') });
    await page.getByRole('button', { name: 'Open Synthetic Unknown Age', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
    await page.screenshot({ path: path.join(fixture.root, 'mobile-detail.png') });
    await closeDetail();
    await expect(page.getByRole('button', { name: 'Open Synthetic Unknown Age', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('fl05-viewer');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-viewer-password');
    await page.getByRole('button', { name: 'Sign In With Password' }).click();
    await expect(page.getByText('Read-only access: decisions and verified-fact edits are unavailable.')).toBeVisible();
    await page.getByRole('button', { name: 'All active', exact: true }).click();
    await page.getByRole('button', { name: 'Open Synthetic Unknown Age', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Save verified fact' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Pursue Synthetic Unknown Age', exact: true })).toHaveCount(0);
    const forbidden = await context.request.post(`${fixture.origin}/api/admin/deal-hunter/triage/unknown/action`, {
      data: { action: 'pursue', idempotencyKey: 'fc58ba29-b4d1-408f-bf64-fb99c9f18b75',
        expectedDiscoveryRevision: 0, expectedMaterialRevision: 0 },
    });
    assert.equal(forbidden.status(), 401, 'Real backend rejects viewer writes');
    assert.deepEqual(errors, [], 'No browser console/runtime errors');
    assert.deepEqual(external, [], 'No external browser requests');
    assert.deepEqual(fixture.blockedNetwork, [], 'No server provider/network attempts');
    for (const table of ['crm_email_outbox', 'deal_hunter_cim_requests', 'deal_hunter_cim_campaigns',
      'deal_hunter_cim_transmissions', 'deal_hunter_cim_live_provider_authorizations']) {
      assert.equal(fixture.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    }
    assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM deal_hunter_pursuit_enrollments WHERE opportunity_id = ?').get('fresh').n, 1);
    assert.ok(fixture.requests.some((request) => request.method === 'PUT' && request.status === 200 && request.path.endsWith('/facts/broker_company')));
  } finally {
    await page.screenshot({ path: path.join(fixture.root, 'last-state.png') }).catch(() => {});
    fs.writeFileSync(path.join(fixture.root, 'observations.json'), JSON.stringify({
      timings, external, errors, blockedNetwork: fixture.blockedNetwork, requests: fixture.requests,
      environment: 'local synthetic backend; Chromium; no deployed or owner-pilot acceptance',
    }, null, 2));
    await context.tracing.stop({ path: path.join(fixture.root, 'trace.zip') });
  }
});
