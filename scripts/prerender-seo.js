import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allSeoPages } from '../src/content/seoMetadata.js';
import { buildStructuredData } from '../src/content/structuredData.js';

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = path.resolve(path.dirname(scriptPath), '..');
const distDirectory = path.join(rootDirectory, 'dist');
const siteUrl = String(process.env.VITE_PUBLIC_SITE_URL || 'https://www.uckelegroup.com').replace(/\/+$/, '');

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderHead(html, route, title, description, baseUrl = siteUrl, noindex = false) {
  const canonicalUrl = `${baseUrl}${route === '/' ? '' : route}`;
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeCanonicalUrl = escapeHtml(canonicalUrl);

  let output = html
    .replace(/<title>[^<]*<\/title>/i, `<title>${safeTitle}</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, `<meta name="description" content="${safeDescription}" />`);

  const metadata = [
    `<link rel="canonical" href="${safeCanonicalUrl}" />`,
    ...(noindex ? ['<meta name="robots" content="noindex, nofollow" />'] : []),
    `<meta property="og:title" content="${safeTitle}" />`,
    `<meta property="og:description" content="${safeDescription}" />`,
    `<meta property="og:url" content="${safeCanonicalUrl}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Uckele Group" />',
    `<meta property="og:image" content="${escapeHtml(`${baseUrl}/og.png`)}" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:image:alt" content="Uckele Group — a thoughtful long-term home for a great small business" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${safeTitle}" />`,
    `<meta name="twitter:description" content="${safeDescription}" />`,
    `<meta name="twitter:image" content="${escapeHtml(`${baseUrl}/og.png`)}" />`,
    '<script id="structured-data" type="application/ld+json">' + JSON.stringify(buildStructuredData({
      route,
      title,
      description,
      baseUrl,
    })).replaceAll('<', '\\u003c') + '</script>',
  ].join('\n    ');

  return output.replace('</head>', `    ${metadata}\n  </head>`);
}

export async function prerenderSeo({ outputDirectory = distDirectory, baseUrl = siteUrl } = {}) {
  const template = await readFile(path.join(outputDirectory, 'index.html'), 'utf8');

  for (const page of allSeoPages) {
    const destination = page.path === '/'
      ? path.join(outputDirectory, 'index.html')
      : path.join(outputDirectory, page.path.slice(1), 'index.html');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, renderHead(template, page.path, page.title, page.description, baseUrl, page.noindex));
  }

  return allSeoPages.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const pageCount = await prerenderSeo();
  console.log(`Pre-rendered metadata for ${pageCount} public routes.`);
}
