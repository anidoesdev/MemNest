// Builds one HTML page per documentation entry from a content fragment and the shared layout.
// Runs from vite.config.ts, so `vite dev` and `vite build` both see the same pages.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hrefOf, PAGES, SECTIONS } from './pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fragments = join(root, 'src', 'docs');
const outDir = join(root, 'docs');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function head({ title, summary, canonical }) {
  return `    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escape(title)} · Memnest docs</title>
    <meta name="description" content="${escape(summary)}" />
    <meta property="og:title" content="${escape(title)} · Memnest docs" />
    <meta property="og:description" content="${escape(summary)}" />
    <meta property="og:image" content="/og.png" />
    <meta name="theme-color" content="#13201a" />
    <link rel="canonical" href="https://memnest.dev${canonical}" />
    <link rel="icon" href="/favicon.png" type="image/png" />
    <script src="/theme.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" />
    <script type="module" src="/src/docs.ts"></script>`;
}

const BRAND = `<span class="brand-mark" aria-hidden="true"></span>`;

const THEME_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" stroke-linecap="round" /></svg>`;

function bar(current) {
  const link = (href, label, active) => `<a href="${href}"${active ? ' aria-current="page"' : ''}>${label}</a>`;
  return `    <header class="bar">
      <div class="wrap wide">
        <a class="brand" href="/" aria-label="Memnest home">${BRAND}Memnest</a>
        <nav aria-label="Main">
          ${link('/docs/', 'Docs', true)}
          ${link('/plugins', 'Plugins', false)}
          <a href="/#preview">Live preview</a>
        </nav>
        <div class="bar-actions">
          <button class="icon-btn" type="button" data-sidebar-toggle aria-expanded="false" aria-controls="docs-nav" aria-label="Show documentation menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round" /></svg></button>
          <button class="icon-btn" type="button" data-theme-toggle aria-label="Switch theme">${THEME_ICON}</button>
          <a class="gh" href="https://github.com/anidoesdev/MemNest" rel="noopener">GitHub ↗</a>
        </div>
      </div>
    </header>`;
}

function sidebar(currentSlug) {
  const sections = SECTIONS.map((section) => {
    const items = section.pages
      .map((page) => {
        const active = page.slug === currentSlug;
        return `            <li><a href="${hrefOf(page.slug)}"${active ? ' class="on" aria-current="page"' : ''}>${escape(page.nav)}</a></li>`;
      })
      .join('\n');
    return `        <div class="nav-group">
          <span class="nav-title">${escape(section.title)}</span>
          <ul>
${items}
          </ul>
        </div>`;
  }).join('\n');
  return `      <nav class="docs-nav" id="docs-nav" aria-label="Documentation">
${sections}
      </nav>`;
}

function pager(index) {
  const previous = PAGES[index - 1];
  const next = PAGES[index + 1];
  if (!previous && !next) return '';
  const card = (page, rel) =>
    page
      ? `<a class="pager-link ${rel}" href="${hrefOf(page.slug)}"><span>${rel === 'prev' ? 'Previous' : 'Next'}</span><b>${escape(page.title)}</b></a>`
      : '<span></span>';
  return `        <nav class="pager" aria-label="More documentation">${card(previous, 'prev')}${card(next, 'next')}</nav>`;
}

/** Writes every page and returns the Rollup input map. */
export function buildDocs() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const known = new Set(readdirSync(fragments).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')));
  const inputs = {};

  PAGES.forEach((page, index) => {
    if (!known.has(page.slug)) throw new Error(`docs: no fragment src/docs/${page.slug}.html`);
    const content = readFileSync(join(fragments, `${page.slug}.html`), 'utf8').trimEnd();
    const canonical = hrefOf(page.slug);
    const file = page.slug === 'index' ? 'index.html' : `${page.slug}.html`;
    const html = `<!doctype html>
<html lang="en">
  <head>
${head({ title: page.title, summary: page.summary, canonical })}
  </head>
  <body class="docs-page">
    <a class="skip" href="#main">Skip to content</a>
${bar(page.slug)}
    <div class="wrap wide docs-shell">
${sidebar(page.slug)}
      <main id="main" class="docs-main">
        <article class="doc">
          <div class="doc-eyebrow">${escape(PAGES[index].section)}</div>
          <h1>${escape(page.title)}</h1>
          <p class="lede">${escape(page.summary)}</p>
${content}
        </article>
${pager(index)}
      </main>
    </div>
    <footer class="site">
      <div class="wrap wide">
        <span>Memnest · MIT licensed</span>
        <nav aria-label="Footer">
          <a href="/">Home</a>
          <a href="/plugins">Plugins</a>
          <a href="https://github.com/anidoesdev/MemNest" rel="noopener">GitHub</a>
        </nav>
      </div>
    </footer>
  </body>
</html>
`;
    writeFileSync(join(outDir, file), html);
    inputs[page.slug === 'index' ? 'docs' : `docs-${page.slug}`] = join(outDir, file);
  });

  return inputs;
}
