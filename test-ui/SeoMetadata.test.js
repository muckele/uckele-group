import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { escapeHtml, prerenderSeo } from '../scripts/prerender-seo.js';
import { allSeoPages, publicSeoPages, seoContent as sharedSeoContent } from '../src/content/seoMetadata.js';
import { seoContent as clientSeoContent } from '../src/content/siteContent.js';

const htmlTemplate = `<!doctype html>
<html lang="en">
  <head>
    <title>Placeholder</title>
    <meta name="description" content="Placeholder description" />
  </head>
  <body><div id="root"></div></body>
</html>`;
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('pre-rendered SEO metadata', () => {
  test('uses the same metadata object as the hydrated React pages', () => {
    expect(clientSeoContent).toBe(sharedSeoContent);
    expect(new Set(publicSeoPages.map((page) => page.path)).size).toBe(publicSeoPages.length);
  });

  test('writes every route destination with its shared metadata contract', async () => {
    const baseUrl = 'https://example.test';
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'uckele-seo-'));
    temporaryDirectories.push(outputDirectory);
    await writeFile(path.join(outputDirectory, 'index.html'), htmlTemplate);

    await expect(prerenderSeo({ outputDirectory, baseUrl })).resolves.toBe(allSeoPages.length);

    for (const page of allSeoPages) {
      const destination = page.path === '/'
        ? path.join(outputDirectory, 'index.html')
        : path.join(outputDirectory, page.path.slice(1), 'index.html');
      const output = await readFile(destination, 'utf8');
      const canonicalUrl = `${baseUrl}${page.path === '/' ? '' : page.path}`;

      expect(output).toContain(`<title>${escapeHtml(page.title)}</title>`);
      expect(output).toContain(`<meta name="description" content="${escapeHtml(page.description)}" />`);
      expect(output).toContain(`<link rel="canonical" href="${canonicalUrl}" />`);
      expect(output).toContain(`"url":"${canonicalUrl}"`);
      expect(output).toContain(`<meta property="og:image" content="${baseUrl}/og.png" />`);
      expect(output).toContain('<meta property="og:image:width" content="1200" />');
      expect(output).toContain('"@type":"Organization"');
      expect(output).toContain('"@type":"Person"');
      expect(output).toContain('"@type":"WebSite"');
      expect(output).toContain('"sameAs":["https://www.linkedin.com/in/mathew-uckele"]');
      if (page.path === '/faq') {
        expect(output).toContain('"@type":"FAQPage"');
        expect(output.match(/"@type":"Question"/g)).toHaveLength(10);
      }
      if (['/about', '/criteria', '/why-sell-to-me', '/process', '/faq', '/contact', '/privacy'].includes(page.path)) {
        expect(output).toContain('"@type":"BreadcrumbList"');
      }
      if (page.noindex) expect(output).toContain('<meta name="robots" content="noindex, nofollow" />');
    }
  });
});
