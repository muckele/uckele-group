import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { startFixture } from './fixture.js';
import { seedGrowth, fingerprint } from './growth-fixture.js';
import { observeOwnedBrowserSpawn } from '../scripts/fl05-owned-process.js';

test('FL05 rendered volume: real UI at1000 current /5000 archived, desktop and narrow viewport', { timeout: 120_000 }, async (t) => {
  const fixture = await startFixture(t);
  seedGrowth(fixture.db);
  fixture.db.prepare(`INSERT INTO email_suppressions
    (id,normalized_email,reason,source,created_at,created_by,metadata)
    VALUES ('browser-volume-opt-out','broker@example.test','explicit-opt-out','synthetic',?,'fixture','{}')`).run(new Date().toISOString());
  const before = fingerprint(fixture.db);
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
  const deadline = performance.now() + 5000;
  while (!fs.existsSync(registration) && performance.now() < deadline) await delay(25);
  assert.equal(fs.readFileSync(registration, 'utf8'), String(browserPid));
  const browser = await chromium.connect(browserServer.wsEndpoint()); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const external = [], errors = [], samples = [], renderer = [], network = [], responseReads = [], detailDispatches = [];
  const primaryDetail = (url) => /^\/api\/admin\/deal-hunter\/triage\/[^/]+$/.test(url.pathname);
  let passed = false;
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
    external.push(route.request().url()); return route.abort('blockedbyclient');
  });
  await context.addInitScript(() => {
    window.__ugVolume = { next: null, start: null, longTasks: [] };
    for (const event of ['click', 'input', 'keydown', 'wheel']) document.addEventListener(event, () => {
      const state = window.__ugVolume;
      if (state.next === event && state.start === null) state.start = performance.now();
    }, { capture: true, passive: true });
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (window.__ugVolume.longTasks.length < 200) {
        window.__ugVolume.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (primaryDetail(url)) detailDispatches.push({ path: url.pathname, method: request.method() });
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname !== '/api/admin/deal-hunter/triage' && !primaryDetail(url)) return;
    const item = { path: url.pathname, query: Object.fromEntries(url.searchParams), status: response.status() };
    network.push(item);
    responseReads.push(response.body().then((body) => {
      item.bytes = body.length;
      const data = JSON.parse(body.toString('utf8'));
      item.rows = Array.isArray(data.rows) ? data.rows.length : null;
      item.areaRows = Array.isArray(data.areas) ? data.areas.map((area) => area.rows.length) : [];
    }).catch((error) => { item.bodyError = error.message; }));
  });
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const render = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measure = async (viewport, action, event, run) => {
    await page.evaluate((kind) => { window.__ugVolume.next = kind; window.__ugVolume.start = null; }, event);
    await run(); await render();
    const duration = await page.evaluate(() => {
      const value = window.__ugVolume.start;
      window.__ugVolume.next = null;
      return value === null ? null : performance.now() - value;
    });
    assert.ok(Number.isFinite(duration), `${action} must start at a real input event`);
    samples.push({ viewport, action, durationMs: duration });
  };
  const metrics = async (viewport, phase) => {
    const result = await cdp.send('Performance.getMetrics');
    const selected = Object.fromEntries(result.metrics.filter((m) => ['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','LayoutCount'].includes(m.name)).map((m) => [m.name, m.value]));
    renderer.push({ viewport, phase, ...selected, domElements: await page.locator('*').count() });
  };
  try {
    await page.goto(`${fixture.origin}/admin/deal-hunter`);
    await page.getByLabel('Username', { exact: true }).fill('fl05-owner');
    await page.getByLabel('Password', { exact: true }).fill('synthetic-owner-password');
    await measure('desktop', 'login-to-inbox', 'click', async () => {
      await page.getByRole('button', { name: 'Sign In With Password' }).click();
      await expect(page.getByRole('button', { name: 'All active', exact: true })).toBeVisible();
    });
    for (const [viewport, size] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]]) {
      const detailCountAtStart = detailDispatches.length;
      await page.setViewportSize(size);
      await page.getByRole('tab', { name: 'Fresh-first Inbox', exact: true }).click();
      await page.getByLabel('Search opportunities', { exact: true }).fill('');
      await measure(viewport, 'all-active-render', 'click', async () => {
        await page.getByRole('button', { name: 'All active', exact: true }).click();
        await expect(page.getByRole('region', { name: 'All active', exact: true })).toContainText('1007 opportunities');
      });
      const active = page.getByRole('list', { name: 'All active opportunities', exact: true });
      await expect(active.locator(':scope > li')).toHaveCount(25);
      await expect(active.getByRole('button', { name: 'Open Synthetic Volume active 0', exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(fixture.root, `${viewport}-growth-inbox.png`) });
      await page.getByRole('tab', { name: 'Passed', exact: true }).click();
      const search = page.getByLabel('Search opportunities', { exact: true });
      const queue = page.getByRole('list', { name: 'Opportunity queue', exact: true });
      for (let index = 0; index < 10; index += 1) {
        const query = index % 2 === 0 ? 'volume-archive-00000' : 'Volume archive retained';
        await measure(viewport, 'archive-search-render', 'input', async () => {
          const response = page.waitForResponse((r) => r.url().includes('/api/admin/deal-hunter/triage?')
            && new URL(r.url()).searchParams.get('search') === query);
          await search.fill(query); assert.equal((await response).status(), 200);
          await expect(queue.locator(':scope > li')).toHaveCount(index % 2 === 0 ? 1 : 25);
          if (index % 2 !== 0) await expect(page.getByText('Page 1 of 200', { exact: true })).toBeVisible();
        });
      }
      assert.equal(detailDispatches.length, detailCountAtStart, 'Queue/search does not eagerly request opportunity details');
      await page.evaluate(() => {
        document.activeElement?.blur();
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      await render();
      const scrollStart = await page.evaluate(() => window.scrollY);
      assert.ok(scrollStart < 100, 'Start the wheel check near the top after layout settles');
      await page.mouse.move(size.width / 2, size.height / 2);
      await measure(viewport, 'archive-scroll-render', 'wheel', async () => {
        await page.mouse.wheel(0, 500);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollStart);
      });
      samples.at(-1).scrollFrom = scrollStart;
      samples.at(-1).scrollTo = await page.evaluate(() => window.scrollY);
      await metrics(viewport, 'before-repeated-detail');
      const opener = queue.getByRole('button', { name: 'Open Synthetic Volume archive 0', exact: true });
      for (let index = 0; index < 10; index += 1) {
        const previousDetails = detailDispatches.length;
        await measure(viewport, 'detail-open-render', 'click', async () => {
          await opener.click();
          await expect(page.getByRole('dialog')).toContainText('Synthetic Volume archive 0');
          await expect(page.getByRole('button', { name: 'Close opportunity detail' })).toBeFocused();
          await expect(page.getByRole('dialog')).toContainText('Historical archive view. This retained score is not current; actions are unavailable.');
        });
        assert.deepEqual(detailDispatches.slice(previousDetails), [{
          path: '/api/admin/deal-hunter/triage/volume-archive-00000', method: 'GET',
        }], 'Opening one archive dispatches exactly its detail read');
        await expect(page.getByRole('dialog').getByRole('button', { name: /^(Pursue |Watch |Pass |Save verified fact|Mark reviewed|Prepare |Approve |Start |Stop )/ })).toHaveCount(0);
        await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0);
        await page.keyboard.press('Tab');
        assert.equal(await page.getByRole('dialog').evaluate((element) => element.contains(document.activeElement)), true);
        if (index === 0) await page.screenshot({ path: path.join(fixture.root, `${viewport}-growth-detail.png`) });
        await measure(viewport, 'detail-close-render', 'keydown', async () => {
          await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
          await expect(opener).toBeFocused(); await expect(search).toHaveValue('Volume archive retained');
        });
      }
      for (let index = 0; index < 10; index += 1) await measure(viewport, 'archive-page-render', 'click', async () => {
        const next = index % 2 === 0;
        await page.getByRole('button', { name: next ? 'Next page' : 'Previous page', exact: true }).click();
        await expect(page.getByText(`Page ${next ? 2 : 1} of 200`, { exact: true })).toBeVisible();
        await expect(queue.getByRole('button', { name: `Open Synthetic Volume archive ${next ? 25 : 0}`, exact: true })).toBeVisible();
        await expect(queue.locator(':scope > li')).toHaveCount(25);
      });
      await metrics(viewport, 'after-repeated-detail-and-pages');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow');
      await page.screenshot({ path: path.join(fixture.root, `${viewport}-growth-archive.png`) });
    }
    await Promise.all(responseReads);
    assert.equal(fingerprint(fixture.db), before, 'Rendered reads preserve all protected state');
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(fixture.blockedNetwork, []);
    assert.ok(network.length > 10 && network.every((item) => item.status === 200
      && !item.bodyError && item.bytes > 0 && item.bytes < 512 * 1024 && (item.rows === null || item.rows <= 100)
      && item.areaRows.every((count) => count <= 25)),
    'Every completed queue/detail response has a bounded payload');
    assert.ok(fixture.requests.every((item) => item.method === 'GET' || (item.method === 'POST' && item.path === '/api/admin/session')));
    passed = true;
  } finally {
    await Promise.all(responseReads);
    const longTasks = await page.evaluate(() => window.__ugVolume?.longTasks || []).catch(() => []);
    const summaries = [...new Set(samples.map((s) => `${s.viewport}:${s.action}`))].map((key) => {
      const values = samples.filter((s) => `${s.viewport}:${s.action}` === key).map((s) => s.durationMs).sort((a,b) => a-b);
      return { key, count: values.length, medianMs: values[Math.ceil(values.length * 0.5)-1], p95Ms: values[Math.ceil(values.length * 0.95)-1] };
    });
    const observations = { status: passed ? 'passed' : 'failed', browser: browser.version(), dataset: { currentSeeded: 1000, archivedSeeded: 5000, canonical: 6008 },
      summaries, samples, renderer, longTasks, network, detailDispatches, external, errors, blockedNetwork: fixture.blockedNetwork,
      limits: 'Synthetic Chromium desktop engine, two viewports, warm local assets, no CPU/network throttling. Event-to-verified-render includes assertion polling and two frames, not standardized INP or production p95. CDP heap/DOM metrics are not whole-browser RSS or leak proof.',
      protectedStateUnchanged: fingerprint(fixture.db) === before };
    fs.writeFileSync(path.join(fixture.root, 'browser-volume-observations.json'), JSON.stringify(observations, null, 2));
    fs.writeFileSync(path.join(fixture.root, 'browser-volume-requests.json'), JSON.stringify(fixture.requests, null, 2));
    t.diagnostic(`FL05_BROWSER_VOLUME_OBSERVATIONS ${JSON.stringify({ ...observations, samples: undefined, network: undefined,
      detailDispatches: undefined, networkSummary: { responses: network.length, detailDispatches: detailDispatches.length,
        maxBytes: Math.max(...network.map((item) => item.bytes || 0)), maxRows: Math.max(...network.map((item) => item.rows || 0)) } })}`);
    await page.screenshot({ path: path.join(fixture.root, 'browser-volume-last-state.png') }).catch(() => {});
    await context.tracing.stop({ path: path.join(fixture.root, 'trace.zip') });
  }
});
