// Build the docs hub at nekkoagent.com/docs from the Markdown in this repo.
//
// docs/hub/nav.json lists the pages; each renders from one Markdown file. The
// website has no build step on Vercel, so the output is committed:
//   apps/website/docs/<slug>.html   the page (cleanUrls serves it at /docs/<slug>)
//   apps/website/docs/<slug>.md     the same page as Markdown, for agents
//   apps/website/docs/search.json   the client-side search index
//   apps/website/docs/media/        images the pages use
//   apps/website/llms-full.txt      every page in one file
// plus a generated docs section in llms.txt and the docs URLs in sitemap.xml.
//
//   node scripts/build-docs.mjs          write the output
//   node scripts/build-docs.mjs --check  exit 1 if the committed output is stale
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(repo, 'apps', 'website');
const outDir = join(site, 'docs');
const ORIGIN = 'https://nekkoagent.com';
const GITHUB = 'https://github.com/nekko-labs/nekko-agent';
const ASSET_VERSION = 'docs-1';

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-'); // one dash per space, as GitHub does ("a & b" -> "a--b")
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function loadNav(root = repo) {
  const nav = JSON.parse(readFileSync(join(root, 'docs', 'hub', 'nav.json'), 'utf8'));
  const pages = [];
  for (const section of nav.sections) {
    for (const page of section.pages) pages.push({ ...page, section: section.title });
  }
  return { sections: nav.sections, pages };
}

const pageUrl = (slug) => (slug ? `/docs/${slug}` : '/docs');
const pageFile = (slug) => slug || 'index';

// Resolve a link written in a source file. Links to another hub page become
// /docs/<slug>; other repo files go to GitHub; local images are copied into
// docs/media. External and same-page links pass through.
function makeResolver(pages, media) {
  const bySource = new Map(pages.map((p) => [posix.normalize(p.source), p]));
  return function resolveHref(href, source, { image = false, absolute = false } = {}) {
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
    if (href.startsWith('/')) return absolute ? ORIGIN + href : href;
    const [path, hash = ''] = href.split('#');
    const target = posix.normalize(posix.join(posix.dirname(source), decodeURI(path)));
    if (target.startsWith('..')) return href;
    if (image) {
      const file = join(repo, target);
      if (!existsSync(file)) throw new Error(`${source}: image not found: ${href}`);
      const name = basename(target);
      const taken = media.get(name);
      if (taken && taken !== file) throw new Error(`${source}: two images named ${name}`);
      media.set(name, file);
      const url = `/docs/media/${name}`;
      return absolute ? ORIGIN + url : url;
    }
    const page = bySource.get(target);
    const anchor = hash ? `#${hash}` : '';
    if (page) return (absolute ? ORIGIN : '') + pageUrl(page.slug) + anchor;
    if (!existsSync(join(repo, target))) throw new Error(`${source}: broken link: ${href}`);
    return `${GITHUB}/blob/main/${target}${anchor}`;
  };
}

function render(page, resolveHref) {
  const source = readFileSync(join(repo, page.source), 'utf8').replace(/\r\n/g, '\n');
  const toc = [];
  const used = new Map();
  const headingIds = [];
  let title = page.title;
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === 'link') token.href = resolveHref(token.href, page.source);
      if (token.type === 'image') token.href = resolveHref(token.href, page.source, { image: true });
      if (token.type === 'heading') {
        let id = slugify(token.text) || 'section';
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        headingIds.push(id);
      }
    },
    hooks: {
      // Wrap tables so a wide one scrolls inside the column instead of the page.
      postprocess: (out) => out.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>'),
    },
    renderer: {
      heading({ tokens, depth }) {
        const id = headingIds.shift();
        const inner = this.parser.parseInline(tokens);
        if (depth === 1) {
          title = inner.replace(/<[^>]+>/g, '');
          return '';
        }
        // Already escaped by marked: the layout inserts it as HTML.
        if (depth <= 3) toc.push({ depth, id, html: inner.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const label = (lang || '').split(/\s/)[0];
        return (
          `<div class="code">${label ? `<span class="code-lang">${escapeHtml(label)}</span>` : ''}` +
          `<button class="copy" type="button" aria-label="Copy code">Copy</button>` +
          `<pre><code${label ? ` class="language-${escapeHtml(label)}"` : ''}>${escapeHtml(text)}</code></pre></div>\n`
        );
      },
      link({ href, title: t, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href) && !href.startsWith(ORIGIN);
        return `<a href="${escapeHtml(href)}"${t ? ` title="${escapeHtml(t)}"` : ''}${external ? ' rel="noopener"' : ''}>${inner}</a>`;
      },
      image({ href, text }) {
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" />`;
      },
    },
  });
  const html = marked.parse(source);

  // The Markdown copy for agents: same text, links made absolute.
  const md = source.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, bang, text, href, t) => {
    const fixed = resolveHref(href, page.source, { image: bang === '!', absolute: true });
    return `${bang}[${text}](${fixed}${t})`;
  });

  // Plain text for the search index, one entry per section.
  const sections = [];
  let current = { id: '', heading: title, text: '' };
  for (const token of marked.lexer(source)) {
    if (token.type === 'heading') {
      if (current.text.trim() || current.id) sections.push(current);
      current = { id: token.depth === 1 ? '' : slugify(token.text), heading: token.text.replace(/[`*_]/g, ''), text: '' };
    } else if (token.type !== 'space') {
      current.text += ' ' + plain(token.raw);
    }
  }
  sections.push(current);
  return { title, html, toc, md, sections };
}

function plain(raw) {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_>#|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function layout({ page, rendered, sections, prev, next }) {
  const url = pageUrl(page.slug);
  const canonical = ORIGIN + url;
  const fullTitle = page.slug ? `${rendered.title} · Nekko Agent docs` : 'Nekko Agent docs: getting started';
  const sidebar = sections
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2><ul>` +
        s.pages
          .map((p) => {
            const current = p.slug === page.slug;
            return `<li><a href="${pageUrl(p.slug)}"${current ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`;
          })
          .join('') +
        `</ul></section>`,
    )
    .join('');
  const toc = rendered.toc.length
    ? `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>` +
      `<li><a href="#top">${escapeHtml(rendered.title)}</a></li>` +
      rendered.toc
        .map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${h.html}</a></li>`)
        .join('') +
      `</ul></nav>`
    : '';
  const pager = [
    prev
      ? `<a class="prev" href="${pageUrl(prev.slug)}"><span>Previous</span>${escapeHtml(prev.title)}</a>`
      : '<span></span>',
    next
      ? `<a class="next" href="${pageUrl(next.slug)}"><span>Next</span>${escapeHtml(next.title)}</a>`
      : '<span></span>',
  ].join('');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: rendered.title,
    description: page.description,
    url: canonical,
    inLanguage: 'en',
    isPartOf: { '@id': 'https://nekkoagent.com/#website' },
    publisher: { '@id': 'https://nekkolabs.com/#organization' },
    about: { '@id': 'https://nekkoagent.com/#app' },
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(fullTitle)}</title>
    <meta name="description" content="${escapeHtml(page.description)}" />
    <link rel="canonical" href="${canonical}" />
    <link rel="alternate" type="text/markdown" href="/docs/${pageFile(page.slug)}.md" />
    <link rel="alternate" type="text/plain" href="/llms.txt" />
    <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />
    <meta name="theme-color" content="#101714" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=nekko-agent-5" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Nekko Agent" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:title" content="${escapeHtml(fullTitle)}" />
    <meta property="og:description" content="${escapeHtml(page.description)}" />
    <meta property="og:image" content="https://nekkoagent.com/og.png?v=nekko-agent-5" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/docs.css?v=${ASSET_VERSION}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
      rel="stylesheet"
      media="print"
      onload="this.media='all'"
    />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  </head>
  <body>
    <a class="skip" href="#content">Skip to content</a>
    <header class="topbar">
      <button class="menu" type="button" aria-label="Open the docs menu" aria-controls="sidebar" aria-expanded="false">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <a class="brand" href="/"><img src="/favicon.svg?v=nekko-agent-5" alt="" width="22" height="22" /> NEKKO AGENT</a>
      <a class="docs-home" href="/docs">Docs</a>
      <button class="search" type="button" aria-label="Search the docs" aria-haspopup="dialog">
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m11 11 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <span>Search</span><kbd>Ctrl K</kbd>
      </button>
      <nav class="top-links" aria-label="Site">
        <a href="https://github.com/nekko-labs/nekko-agent" rel="noopener">GitHub</a>
        <a class="download" href="/#download">Download</a>
      </nav>
    </header>
    <div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="Docs">${sidebar}</aside>
      <main id="content">
        <article class="prose" id="top">
          <p class="kicker">${escapeHtml(page.section)}</p>
          <h1>${escapeHtml(rendered.title)}</h1>
          <p class="page-tools">
            <a href="/docs/${pageFile(page.slug)}.md">View as Markdown</a>
            <a href="/llms.txt">llms.txt</a>
          </p>
${rendered.html}
          <footer class="page-foot">
            <a class="edit" href="${GITHUB}/edit/main/${page.source}" rel="noopener">Edit this page on GitHub</a>
            <div class="pager">${pager}</div>
          </footer>
        </article>
      </main>
      <aside class="toc-col">${toc}</aside>
    </div>
    <dialog class="search-dialog" aria-label="Search the docs">
      <form method="dialog" class="search-box">
        <input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false" />
        <button type="submit" class="esc" aria-label="Close search">Esc</button>
      </form>
      <ul class="results" role="listbox" aria-label="Results"></ul>
    </dialog>
    <script src="/docs.js?v=${ASSET_VERSION}" defer></script>
  </body>
</html>
`;
}

function replaceBetween(text, start, end, body) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  const block = `${start}\n${body}\n${end}`;
  if (a === -1 || b === -1) return `${text.trimEnd()}\n\n${block}\n`;
  return text.slice(0, a) + block + text.slice(b + end.length);
}

export function build() {
  const { sections, pages } = loadNav();
  const media = new Map();
  const resolveHref = makeResolver(pages, media);
  const files = new Map(); // path relative to apps/website -> content (string or Buffer)
  const index = [];
  const full = [
    '# Nekko Agent documentation',
    '',
    `> Every page of ${ORIGIN}/docs in one file. Generated from the Markdown in ${GITHUB}.`,
    '',
  ];

  const rendered = pages.map((page) => ({ page, rendered: render(page, resolveHref) }));
  rendered.forEach(({ page, rendered: r }, i) => {
    const name = pageFile(page.slug);
    files.set(`docs/${name}.html`, layout({ page, rendered: r, sections, prev: pages[i - 1], next: pages[i + 1] }));
    files.set(`docs/${name}.md`, r.md.trimEnd() + '\n');
    full.push(`<!-- ${ORIGIN}${pageUrl(page.slug)} -->`, '', r.md.trim(), '', '---', '');
    for (const s of r.sections) {
      index.push({
        page: r.title,
        section: page.section,
        url: pageUrl(page.slug) + (s.id ? `#${s.id}` : ''),
        heading: s.id ? s.heading : '',
        text: s.text.trim().slice(0, 600),
      });
    }
  });
  files.set('docs/search.json', JSON.stringify(index) + '\n');
  files.set('llms-full.txt', full.join('\n').trimEnd() + '\n');
  for (const [name, file] of media) files.set(`docs/media/${name}`, readFileSync(file));

  const docsList = [
    '## Documentation',
    '',
    `Full docs in one file: ${ORIGIN}/llms-full.txt. Each page is also available as Markdown at the .md URL below.`,
    '',
    ...sections.flatMap((s) => [
      `### ${s.title}`,
      '',
      ...s.pages.map((p) => `- [${p.title}](${ORIGIN}/docs/${pageFile(p.slug)}.md): ${p.description}`),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
  const llms = readFileSync(join(site, 'llms.txt'), 'utf8').replace(/\r\n/g, '\n');
  files.set('llms.txt', replaceBetween(llms, '<!-- docs:start -->', '<!-- docs:end -->', docsList));

  const sitemap = readFileSync(join(site, 'sitemap.xml'), 'utf8').replace(/\r\n/g, '\n');
  const urls = pages
    .map((p) => `  <url>\n    <loc>${ORIGIN}${pageUrl(p.slug)}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${p.slug ? '0.7' : '0.9'}</priority>\n  </url>`)
    .join('\n');
  files.set(
    'sitemap.xml',
    replaceBetween(sitemap.replace('</urlset>', '').trimEnd() + '\n', '  <!-- docs:start -->', '  <!-- docs:end -->', urls)
      .trimEnd() + '\n</urlset>\n',
  );
  return files;
}

// Every file the build owns under docs/, so a removed page's output is noticed.
function existingOutput() {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(site, path).split('\\').join('/'));
    }
  };
  walk(outDir);
  return found;
}

const hash = (data) => createHash('sha256').update(data).digest('hex');

export function stale(files = build()) {
  const problems = [];
  for (const [path, content] of files) {
    const file = join(site, path);
    if (!existsSync(file)) problems.push(`missing ${path}`);
    else {
      const current = readFileSync(file);
      const expected = typeof content === 'string' ? Buffer.from(content) : content;
      const normal = (b) => (extname(path).match(/\.(png|jpe?g|gif|webp)$/) ? b : Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n')));
      if (hash(normal(current)) !== hash(normal(expected))) problems.push(`out of date ${path}`);
    }
  }
  for (const path of existingOutput()) if (!files.has(path)) problems.push(`left over ${path}`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = build();
  if (process.argv.includes('--check')) {
    const problems = stale(files);
    if (problems.length) {
      console.error(`The docs site is out of date with its Markdown. Run \`npm run docs\`.\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`docs site up to date (${files.size} files)`);
  } else {
    rmSync(outDir, { recursive: true, force: true });
    for (const [path, content] of files) {
      const file = join(site, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    console.log(`wrote ${files.size} files to apps/website`);
  }
}
